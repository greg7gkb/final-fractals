# Architecture Overview — Final Fractals

A deep-dive into how the app is structured, how the GPU renders fractals, and the mathematics behind each fractal set.

---

## 1. High-Level Structure

```
final-fractals/
├── index.html                   # Single-page app shell: canvas + UI overlay (pure HTML/CSS)
├── src/
│   ├── main.ts                  # Entry point — wires all modules, drives the render loop
│   ├── renderer/
│   │   ├── WebGLRenderer.ts     # WebGL2 context, shader compilation, uniform uploads, draw calls
│   │   └── shaders.ts           # All GLSL source code (vertex + fragment) as TS string constants
│   ├── navigation/
│   │   ├── Camera.ts            # View state (centre, zoom, rotation) + coordinate math
│   │   └── InputHandler.ts      # Mouse, trackpad, touch, keyboard → camera mutations
│   └── ui/
│       └── Controls.ts          # HTML panel ↔ uniform sync; interactive tutor state
├── vite.config.ts               # Build tool (Vite) — dev server + production bundle
└── tsconfig.json                # TypeScript compiler config
```

**Technology choices:**
- **Vite** — zero-config dev server with HMR, TypeScript out of the box
- **WebGL2** — GPU-accelerated rendering via fragment shaders (see §2)
- **Vanilla TypeScript** — no framework; the DOM surface is small and the heavy work is in GLSL

---

## 2. The Rendering Pipeline

Fractals are rendered entirely on the **GPU** using a WebGL2 fragment shader. There is no CPU-side pixel loop.

### 2.1 Why the GPU?

A 1920×1080 canvas has ~2 million pixels. For each frame we must test whether the complex number corresponding to that pixel escapes to infinity under iteration — hundreds of times per pixel. A CPU loop would be far too slow for interactive frame rates. A GPU runs thousands of shader invocations **in parallel**, one per pixel.

### 2.2 The Big-Triangle Trick

Rather than drawing a textured quad, we use a single oversized triangle (3 vertices, no vertex buffer):

```glsl
// vertex shader — gl_VertexID gives each vertex a unique index 0, 1, 2
vec2 positions[3] = vec2[3](
  vec2(-1.0, -1.0),   // bottom-left
  vec2( 3.0, -1.0),   // far right  (off-screen, clipped)
  vec2(-1.0,  3.0)    // far top    (off-screen, clipped)
);
gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
```

The rasteriser clips to `[-1, 1]²`, so only the canvas area is shaded. No VBO needed, zero geometry uploaded to the GPU.

### 2.3 Pixel → Complex Plane

Every fragment shader invocation knows its screen coordinate (`gl_FragCoord.xy`). The coordinate transform maps it to a complex number `c`:

```
uv   =  (fragCoord − resolution/2) / resolution.y       # normalise; origin = screen centre
p    =  uv × zoom                                        # scale by visible height
r    =  rotate(p, θ)                                     # apply view rotation
c    =  centre + r                                       # translate to view centre
```

This is mirrored exactly in `Camera.ts` (`pixelToComplex`, `pixelDeltaToComplex`) so that JavaScript-side coordinate picking (zoom-to-cursor, rotation pivot) stays in sync with what the shader draws.

### 2.4 Uniforms

Uniforms are values uploaded from JavaScript to the GPU once per frame:

| Uniform | Type | Purpose |
|---|---|---|
| `u_center_hi / u_center_lo` | `vec2` × 2 | View centre as a double-double (see §3) |
| `u_zoom` | `float` | Visible height in complex units |
| `u_rotation` | `float` | View rotation in radians |
| `u_maxIterations` | `int` | Iteration budget |
| `u_fractalType` | `int` | 0–4 selects the fractal |
| `u_juliaC` | `vec2` | Julia set constant `c` |
| `u_colorScheme` | `int` | 0–4 selects the colour palette |

### 2.5 Render Loop

`main.ts` uses a **dirty flag** pattern — `requestAnimationFrame` runs every frame but only calls `renderer.render()` when something has changed. This saves GPU work (and battery) while the view is idle.

---

## 3. Double-Double Precision for Deep Zoom

### 3.1 The Problem

GPU shaders use 32-bit IEEE 754 floats (`float`), which have ~7 significant decimal digits. At deep zoom the difference between adjacent pixels becomes smaller than float32 can represent, and the image degrades into solid-coloured blocks (typically around zoom level ~10⁻⁵).

### 3.2 The Solution: Double-Double Arithmetic

We represent each coordinate as a pair of float32 values `(hi, lo)` where the true value is `hi + lo` exactly, and `|lo| ≤ ½ · ulp(hi)`. This gives ~15 significant digits — enough to zoom to ~10⁻¹⁴.

**TwoSum** (Knuth): given floats `a` and `b`, compute `(s, e)` such that `s = fl(a+b)` and `s + e = a + b` exactly (no bits lost):

```glsl
vec2 twoSum(float a, float b) {
  float s = a + b;
  float v = s - a;
  float e = (a - (s - v)) + (b - v);
  return vec2(s, e);
}
```

**TwoProd** (Dekker/Veltkamp): same idea for multiplication, using a bit-split to separate the mantissa:

```glsl
vec2 split(float a) {          // split into two non-overlapping 12-bit halves
  float t = 4097.0 * a;        // 4097 = 2^12 + 1
  float hi = t - (t - a);
  return vec2(hi, a - hi);
}

vec2 twoProd(float a, float b) {
  float p  = a * b;
  vec2  as = split(a);  vec2 bs = split(b);
  float e  = ((as.x*bs.x - p) + as.x*bs.y + as.y*bs.x) + as.y*bs.y;
  return vec2(p, e);
}
```

The centre is split on the CPU side using `Math.fround()`:

```typescript
const reHi = Math.fround(camera.centerRe);   // nearest float32
const reLo = camera.centerRe - reHi;         // exact residual
```

Both the **coordinate transform** and the **iteration loop** (for Mandelbrot, Julia, Burning Ship, Tricorn) operate entirely in double-double arithmetic, so deep zoom produces sharp, block-free images at any level the GPU can render within its iteration budget.

---

## 4. The Fractal Mathematics

All five fractals live in the **complex plane** — a 2D space where each point is a complex number `z = x + yi`. GPU shaders represent this as `vec2(x, y)`.

Complex multiplication:
```
(a + bi)(c + di) = (ac − bd) + (ad + bc)i
```

Complex squaring (optimised):
```
(x + yi)² = (x² − y²) + 2xyi
```

### 4.1 Mandelbrot Set

The Mandelbrot set is the set of complex numbers `c` for which the sequence

```
z₀ = 0
zₙ₊₁ = zₙ² + c
```

remains **bounded** (does not diverge to infinity).

In practice we iterate up to `maxIterations` times and check whether `|z|² > 4` (the "escape radius" — once exceeded, the orbit diverges). Points that never escape are coloured black (inside the set); points that escape are coloured by how quickly they did so.

**Smooth colouring** removes the harsh banding of raw integer counts using the magnitude of `z` at the escape step:

```
smooth_t = i − log₂( log₂(|z|²) / 2 )
```

This is derived from the fact that `|zₙ|` grows roughly as `|z₀|^(2ⁿ)`, so taking two nested logs recovers a continuous value.

### 4.2 Julia Sets

Julia sets use the **same iteration** as Mandelbrot but with roles swapped:

```
z₀ = pixel           (the complex coordinate of the pixel)
zₙ₊₁ = zₙ² + c      (c is a fixed constant, user-controlled)
```

Each value of `c` produces a completely different shape. The Julia set for `c` is geometrically related to the Mandelbrot set — the boundary of the Mandelbrot set at point `c` predicts how "interesting" the Julia set for that `c` will be.

**Default constant:** `c = −0.7269 + 0.1889i` (produces a dendrite-like shape)

### 4.3 Burning Ship

The Burning Ship fractal applies absolute values to both components of `z` before squaring, then adds `c`:

```
z₀ = 0
zₙ₊₁ = (|Re(zₙ)| + |Im(zₙ)|·i)² + c
```

Taking `|x| + |y|i` "folds" the complex plane into its first quadrant at every step, which breaks the rotational symmetry of the Mandelbrot set. This creates the characteristic asymmetric, ship-like silhouette visible along the negative real axis (the fractal appears upside-down in standard mathematical orientation).

### 4.4 Newton Fractal

Newton's method for finding roots of `f(z) = z³ − 1`:

```
zₙ₊₁ = zₙ − f(zₙ)/f'(zₙ)  =  (2zₙ³ + 1) / (3zₙ²)
```

The three cube roots of unity are the fixed points this converges to:

```
ω₀ = 1                       (coloured red)
ω₁ = e^(2πi/3) = −½ + (√3/2)i   (coloured green)
ω₂ = e^(4πi/3) = −½ − (√3/2)i   (coloured blue)
```

Pixels are coloured by **which root** the iteration converges to, with brightness encoding convergence speed. The fractal boundary between the three basins of attraction is infinitely complex — no matter how deep you zoom into a boundary point, all three colours remain present.

Unlike the escape-time fractals, Newton uses float32 precision. Newton's method converges quadratically (doubling significant digits each step), so useful zoom depths are naturally shallower.

### 4.5 Tricorn (Mandelbar)

The Tricorn (also called the Mandelbar set) is like Mandelbrot but with the **complex conjugate** applied to `z` before squaring:

```
z₀ = 0
zₙ₊₁ = conj(zₙ)² + c    where conj(x + yi) = x − yi
```

Conjugating negates the imaginary part, which is equivalent to reflecting across the real axis at each step. This breaks the holomorphic (complex-analytic) structure of the Mandelbrot iteration, producing 3-fold rotational symmetry and the characteristic spiky, cactus-like filaments.

---

## 5. Navigation & Camera

The camera is defined by three numbers:

| Field | Meaning |
|---|---|
| `centerRe`, `centerIm` | Complex number at the centre of the screen |
| `zoom` | Height of the visible region in complex units (smaller = zoomed in) |
| `rotation` | View rotation in radians |

**Zoom-to-cursor** keeps the complex point under the cursor fixed as zoom changes:

```typescript
// Move centre toward the target by the proportion of zoom change
const scale = 1 − factor;
camera.centerRe += (targetRe − camera.centerRe) * scale;
camera.centerIm += (targetIm − camera.centerIm) * scale;
camera.zoom *= factor;
```

**Rotation pivot** keeps the point under the cursor fixed during Ctrl+drag rotation by rotating the centre around the pivot:

```
centre_new = pivot + rotate(centre_old − pivot, dθ)
```

**Screen → complex delta** (for pan tracking the finger) applies the same CCW rotation as the shader:

```
[dRe]   [cos θ  −sin θ] [−dx · scale]
[dIm] = [sin θ   cos θ] [ dy · scale]
```

Arrow keys compute the same rotation to stay screen-relative regardless of view angle.

---

## 6. Colour Schemes

All colour schemes map a continuous value `t ∈ [0, 1]` to RGB:
- `t = 1` → inside the set → black
- `t → 0` → escaped very quickly → brightest

| Scheme | Approach |
|---|---|
| Ultra Smooth | Cycling HSV hue; 8 palette cycles over the iteration range |
| Fire | Black → red → orange → yellow → white (piecewise linear RGB) |
| Electric | Black → indigo → electric blue → cyan → white |
| Grayscale | `sqrt(1 − t)` luminance ramp (perceptually uniform) |
| Rainbow | Full HSV sweep with 5 cycles |

Newton uses a separate colouring: hue by root index, brightness by convergence speed.

---

## 7. Interactive Tutor

The help overlay (`H`) doubles as a first-run tutorial. Each row has a red dot that tracks whether the user has performed that action. On completion the dot blinks green and fades in place (its DOM space is preserved to prevent text reflow). Once all nine dots are cleared the overlay fades out automatically with a drift animation. If `H` is the final action, the normal hide is suppressed and the fade sequence plays instead.
