/**
 * shaders.ts — GLSL source code for the fractal renderer
 *
 * ═══════════════════════════════════════════════════════════════════
 * HOW WEBGL2 RENDERING WORKS (the big picture)
 * ═══════════════════════════════════════════════════════════════════
 *
 * WebGL2 is a JavaScript API that lets you run programs called
 * "shaders" directly on the GPU. There are two shader stages:
 *
 *   1. VERTEX SHADER  — runs once per vertex (corner of a shape).
 *      Outputs: clip-space position (gl_Position).
 *
 *   2. FRAGMENT SHADER — runs once per PIXEL that lies inside the
 *      rasterised shape. Outputs: the final RGBA colour of that pixel.
 *
 * For a fractal viewer we want to colour every pixel on screen, so we
 * draw a single giant triangle that covers the entire canvas. The
 * vertex shader places that triangle; the fragment shader does all
 * the interesting math — once per pixel, fully in parallel on the GPU.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY STANDARD FLOATS LIMIT ZOOM DEPTH
 * ═══════════════════════════════════════════════════════════════════
 *
 * GPU shaders use 32-bit IEEE 754 floats ("single precision"), which
 * have only ~7 significant decimal digits. As you zoom deeper into the
 * fractal, adjacent pixels represent complex numbers that differ by
 * smaller and smaller amounts. Once the difference falls below float32's
 * resolution, multiple pixels map to the same complex value and the
 * image turns into ugly solid-coloured blocks — typically around zoom ~10⁻⁵.
 *
 * ═══════════════════════════════════════════════════════════════════
 * SOLUTION: DOUBLE-DOUBLE (DD) ARITHMETIC
 * ═══════════════════════════════════════════════════════════════════
 *
 * We can emulate ~15 significant digits using *pairs* of float32 values:
 *
 *   dd(hi, lo)  represents the exact value  hi + lo
 *
 * where |lo| ≤ ½·ulp(hi)  (lo holds the rounding error of hi).
 *
 * This "double-double" technique lets us extend zoom to ~10⁻¹⁴ with
 * no hardware changes — all arithmetic stays in float32; we just do
 * more of it. The cost is roughly 4–8× more GPU work per pixel.
 *
 * Key building block: the TwoSum algorithm (Knuth / Møller 1965).
 * For any two floats a and b, TwoSum computes (s, e) such that:
 *   s = fl(a + b)   (the float32 result)
 *   e = exact(a+b) − s  (the rounding error, also exactly representable)
 * so  s + e = a + b  exactly — no bits are lost.
 *
 * Similarly, TwoProd (Veltkamp 1968 / Dekker 1971) does the same for
 * multiplication, using a "split" that separates a float32 into two
 * non-overlapping 12-bit halves.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHERE DD IS USED IN THIS SHADER
 * ═══════════════════════════════════════════════════════════════════
 *
 *  1. Coordinate transform (pixel → complex plane):
 *     The view centre is passed as two vec2 uniforms (hi + lo).
 *     Pixel offsets from centre (small, float32-exact) are added
 *     using ddAddF(), giving a high-precision starting complex number.
 *
 *  2. Fractal iteration (Mandelbrot, Julia, BurningShip, Tricorn):
 *     Both z and c are tracked as dd complex numbers throughout the
 *     iteration loop. This is what actually allows deep exploration —
 *     just a precise starting point is not enough; z must also be
 *     tracked precisely while it's still near the origin.
 *
 *  3. Escape test and smooth colouring:
 *     Once |z| > 2 the orbit diverges rapidly. At that point z has
 *     magnitude ≥ 2 and float32 is perfectly adequate, so we drop
 *     back to float32 for the escape check and smooth-count formula.
 *
 * ═══════════════════════════════════════════════════════════════════
 * COMPLEX NUMBERS IN GLSL
 * ═══════════════════════════════════════════════════════════════════
 *
 * GLSL has no built-in complex type.  We represent:
 *   • float32 complex z  as  vec2(z.re, z.im)
 *   • dd complex Z        as  four scalars: Z_re_hi, Z_re_lo, Z_im_hi, Z_im_lo
 *     (or equivalently two vec2s: Z_re = (Z_re_hi, Z_re_lo),
 *                                  Z_im = (Z_im_hi, Z_im_lo))
 *
 * ═══════════════════════════════════════════════════════════════════
 * ESCAPE-TIME ALGORITHM
 * ═══════════════════════════════════════════════════════════════════
 *
 *   Fractal       z₀         f(z, c)
 *   ──────────    ────       ──────────────────────────────────
 *   Mandelbrot    (0,0)      z² + c          (c = pixel)
 *   Julia         pixel      z² + c          (c = user constant)
 *   Burning Ship  (0,0)      (|Re(z)|+|Im(z)|·i)² + c
 *   Tricorn       (0,0)      conj(z)² + c    (conjugate before squaring)
 *   Newton        pixel      (2z³+1)/(3z²)   (coloured by root, float32)
 */

// ─────────────────────────────────────────────────────────────────────────────
// VERTEX SHADER
// ─────────────────────────────────────────────────────────────────────────────
// The "big triangle" trick: 3 hard-coded vertices form a triangle that covers
// the entire NDC [-1,1]² clip space. No vertex buffer needed.
export const VERTEX_SHADER_SRC = /* glsl */ `#version 300 es

void main() {
  vec2 positions[3] = vec2[3](
    vec2(-1.0, -1.0),
    vec2( 3.0, -1.0),
    vec2(-1.0,  3.0)
  );
  gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// FRAGMENT SHADER — runs once per pixel
// ─────────────────────────────────────────────────────────────────────────────
export const FRAGMENT_SHADER_SRC = /* glsl */ `#version 300 es
precision highp float;

// ── Uniforms ──────────────────────────────────────────────────────────────
uniform vec2  u_resolution;

// View centre stored as a double-double pair:
//   true centre = u_center_hi + u_center_lo
// Splitting a float64 JS number into two float32s preserves ~15 digits.
uniform vec2  u_center_hi;
uniform vec2  u_center_lo;

uniform float u_zoom;        // visible height in complex units (float32 is fine here)
uniform float u_rotation;    // rotation in radians

uniform int   u_maxIterations;
// 0=Mandelbrot  1=Julia  2=BurningShip  3=Newton  4=Tricorn  5=Custom
// 6=MagnetI  7=MagnetII  8=Phoenix  9=Celtic  10=sin(z)+c  11=e^z+c  12=Rational
uniform int   u_fractalType;
uniform vec2  u_juliaC;      // Julia constant (user-typed, float32 precision is enough)
// 0=UltraSmooth  1=Fire  2=Electric  3=Grayscale  4=Rainbow
// 5=SharkBlue  6=Silver  7=Carmine  8=Bernstein  9=Twilight  10=Lava
uniform int   u_colorScheme;

out vec4 fragColor;

// ═══════════════════════════════════════════════════════════════════════════
// DOUBLE-DOUBLE ARITHMETIC
// ═══════════════════════════════════════════════════════════════════════════
//
// A dd number is vec2(hi, lo) with |lo| ≤ ½·ulp(hi).
// All operations below are exact up to dd precision (~15 decimal digits).

// TwoSum: error-free addition of two float32 values.
// Returns (s, e) such that fl(a+b)=s and s+e=a+b exactly.
// Reference: Knuth, TAOCP vol.2, Theorem B.
vec2 twoSum(float a, float b) {
  float s = a + b;
  float v = s - a;
  // e captures the parts of a and b lost in the rounding of a+b
  float e = (a - (s - v)) + (b - v);
  return vec2(s, e);
}

// Veltkamp split: split a float32 into two non-overlapping 12-bit halves.
// Factor 4097 = 2^12+1 pushes the lower 12 bits into a separate value.
// Required by TwoProd when hardware FMA is unavailable (WebGL2 doesn't guarantee FMA).
vec2 split(float a) {
  float t  = 4097.0 * a;
  float hi = t - (t - a);   // upper 12 bits of mantissa
  return vec2(hi, a - hi);  // lo = exact remainder
}

// TwoProd: error-free product of two float32 values.
// Returns (p, e) such that fl(a*b)=p and p+e=a*b exactly.
// Uses Dekker's method via Veltkamp splitting.
vec2 twoProd(float a, float b) {
  float p  = a * b;
  vec2  as = split(a);
  vec2  bs = split(b);
  // Reconstruct exact error: p + err = a*b  (all float32 ops are exact here)
  float e  = ((as.x*bs.x - p) + as.x*bs.y + as.y*bs.x) + as.y*bs.y;
  return vec2(p, e);
}

// dd + dd  (Priest 1991, Algorithm 5)
vec2 ddAdd(vec2 a, vec2 b) {
  vec2 s = twoSum(a.x, b.x);
  s.y += a.y + b.y;          // absorb low-order parts into error
  return twoSum(s.x, s.y);   // renormalise
}

// dd - dd
vec2 ddSub(vec2 a, vec2 b) {
  return ddAdd(a, vec2(-b.x, -b.y));
}

// dd + float  (adding a regular float to a dd number)
vec2 ddAddF(vec2 a, float b) {
  vec2 s = twoSum(a.x, b);
  s.y += a.y;
  return twoSum(s.x, s.y);
}

// dd * dd  (Dekker 1971)
// The a.y*b.y term is O(eps²) and safely dropped.
vec2 ddMul(vec2 a, vec2 b) {
  vec2 p = twoProd(a.x, b.x);           // exact product of leading terms
  p.y += a.x*b.y + a.y*b.x;            // first-order cross terms
  return twoSum(p.x, p.y);             // renormalise
}

// Multiply a dd number by the exact float 2.0
// (Since 2 is a power of two, this introduces zero rounding error.)
vec2 ddMul2(vec2 a) {
  return vec2(2.0*a.x, 2.0*a.y);
}

// ═══════════════════════════════════════════════════════════════════════════
// COORDINATE TRANSFORM  (screen pixel → dd complex number)
// ═══════════════════════════════════════════════════════════════════════════
//
// Pipeline:
//   gl_FragCoord.xy
//     → normalise to [-0.5·aspect, +0.5·aspect] × [-0.5, +0.5]   (float32, small)
//     → scale by u_zoom                                            (float32, small)
//     → rotate                                                     (float32, small)
//     → add to dd centre                                           (dd, high precision)
//
// The pixel offset (after normalise+scale) is small and fits exactly in float32.
// The precision challenge is only in the final addition to the centre.
//
// Result written to out parameters c_re and c_im (each a dd vec2).
void pixelToComplexDD(out vec2 c_re, out vec2 c_im) {
  // Float32 offset from the canvas centre — accurate since values are small
  vec2 uv = (gl_FragCoord.xy - u_resolution * 0.5) / u_resolution.y;
  vec2 p  = uv * u_zoom;

  // Rotate the offset (still float32 — no precision issue for small values)
  float cosR = cos(u_rotation);
  float sinR = sin(u_rotation);
  float offRe =  p.x*cosR - p.y*sinR;
  float offIm =  p.x*sinR + p.y*cosR;

  // Add the small float32 offset to the high-precision dd centre.
  // This is the step that previously lost all precision at deep zoom.
  c_re = ddAddF(vec2(u_center_hi.x, u_center_lo.x), offRe);
  c_im = ddAddF(vec2(u_center_hi.y, u_center_lo.y), offIm);
}

// ── Smooth iteration count ────────────────────────────────────────────────
// At the escape point |z| ≥ 2, so z has magnitude ≥ 1. Float32 is fine.
float smoothCount(int i, vec2 z_re, vec2 z_im) {
  // Use only the hi (float32) parts — lo is negligible once |z| > 2
  float mod2 = z_re.x*z_re.x + z_im.x*z_im.x;
  return float(i) - log2(log2(mod2) * 0.5);
}

// ═══════════════════════════════════════════════════════════════════════════
// FRACTAL ITERATION FUNCTIONS  (dd versions)
// ═══════════════════════════════════════════════════════════════════════════
//
// Each function takes the pixel's complex coordinate as dd (c_re, c_im)
// and returns a float t ∈ [0,1]:
//   t == 1.0 → inside the set
//   t <  1.0 → escaped; encodes speed for colouring
//
// Inside the loop, both z and c are maintained as dd complex numbers.
// The escape test |z|² > 4 uses float32 (z.hi parts) — accurate once |z| ≥ 2.

// ── Mandelbrot: z ← z² + c,  z₀ = 0,  c = pixel ─────────────────────────
float mandelbrot(vec2 c_re, vec2 c_im) {
  vec2 z_re = vec2(0.0);  // dd zero
  vec2 z_im = vec2(0.0);
  for (int i = 0; i < u_maxIterations; i++) {
    // Compute z² = (z_re + z_im·i)²
    //   new_re = z_re² - z_im²
    //   new_im = 2·z_re·z_im
    vec2 re2    = ddMul(z_re, z_re);
    vec2 im2    = ddMul(z_im, z_im);
    vec2 cross  = ddMul(z_re, z_im);

    // z_new = z² + c
    z_re = ddAdd(ddSub(re2, im2), c_re);
    z_im = ddAdd(ddMul2(cross),   c_im);

    // Escape check — float32 hi parts are enough once |z| > 2
    if (z_re.x*z_re.x + z_im.x*z_im.x > 4.0) {
      return smoothCount(i, z_re, z_im) / float(u_maxIterations);
    }
  }
  return 1.0;
}

// ── Julia: z ← z² + c,  z₀ = pixel,  c = u_juliaC ───────────────────────
// The pixel is the starting z, the Julia constant c is user-controlled.
// c doesn't need extreme precision (user types values like -0.7269).
float julia(vec2 z_re, vec2 z_im) {
  // Promote the float32 Julia constant to dd (lo = 0.0 means no added precision,
  // but the starting z₀ = pixel coordinate is already full dd precision)
  vec2 c_re = vec2(u_juliaC.x, 0.0);
  vec2 c_im = vec2(u_juliaC.y, 0.0);
  for (int i = 0; i < u_maxIterations; i++) {
    vec2 re2   = ddMul(z_re, z_re);
    vec2 im2   = ddMul(z_im, z_im);
    vec2 cross = ddMul(z_re, z_im);
    z_re = ddAdd(ddSub(re2, im2), c_re);
    z_im = ddAdd(ddMul2(cross),   c_im);
    if (z_re.x*z_re.x + z_im.x*z_im.x > 4.0) {
      return smoothCount(i, z_re, z_im) / float(u_maxIterations);
    }
  }
  return 1.0;
}

// ── Burning Ship: z ← (|Re(z)| + |Im(z)|·i)² + c ────────────────────────
// Taking abs() before squaring "folds" the plane and creates the ship shape.
// With dd: abs of (hi, lo) — if hi > 0 the sign of hi determines the sign.
float burningShip(vec2 c_re, vec2 c_im) {
  vec2 z_re = vec2(0.0);
  vec2 z_im = vec2(0.0);
  for (int i = 0; i < u_maxIterations; i++) {
    // |z_re| and |z_im| in dd: abs(hi, lo) = (|hi|, sign(hi)*lo)
    vec2 az_re = vec2(abs(z_re.x), (z_re.x >= 0.0 ? 1.0 : -1.0) * z_re.y);
    vec2 az_im = vec2(abs(z_im.x), (z_im.x >= 0.0 ? 1.0 : -1.0) * z_im.y);

    vec2 re2   = ddMul(az_re, az_re);
    vec2 im2   = ddMul(az_im, az_im);
    vec2 cross = ddMul(az_re, az_im);
    z_re = ddAdd(ddSub(re2, im2), c_re);
    z_im = ddAdd(ddMul2(cross),   c_im);
    if (z_re.x*z_re.x + z_im.x*z_im.x > 4.0) {
      return smoothCount(i, z_re, z_im) / float(u_maxIterations);
    }
  }
  return 1.0;
}

// ── Custom: De Moivre Multibrot — z ← zⁿ + c ────────────────────────────────
// Uses De Moivre's theorem: zⁿ = rⁿ · (cos(nθ) + i·sin(nθ))
// where r = |z| and θ = arg(z).  Drops to float32 (trig has no dd equivalent).
// Change n to explore different Multibrot sets (n=2 → Mandelbrot, n=3, n=4 …)
float custom(vec2 c_re, vec2 c_im) {
  int n = 3;  // change this to get Multibrot sets: z ← zⁿ + c
  float z_re = 0.0;   // float32 — De Moivre can't use dd precision
  float z_im = 0.0;
  for (int i = 0; i < u_maxIterations; i++) {
    float r      = length(vec2(z_re, z_im));
    float theta  = atan(z_im, z_re);
    float rn     = pow(r, float(n));
    z_re = rn * cos(float(n) * theta) + c_re.x;
    z_im = rn * sin(float(n) * theta) + c_im.x;
    if (z_re*z_re + z_im*z_im > 4.0) {
      return smoothCount(i, vec2(z_re, 0.0), vec2(z_im, 0.0)) / float(u_maxIterations);
    }
  }
  return 1.0;
}

// ── Tricorn (Mandelbar): z ← conj(z)² + c ────────────────────────────────
// Conjugate before squaring: conj(z_re, z_im) = (z_re, -z_im).
// In dd this just negates the im component: (-hi, -lo).
float tricorn(vec2 c_re, vec2 c_im) {
  vec2 z_re = vec2(0.0);
  vec2 z_im = vec2(0.0);
  for (int i = 0; i < u_maxIterations; i++) {
    // conjugate: negate im
    vec2 cz_im = vec2(-z_im.x, -z_im.y);

    vec2 re2   = ddMul(z_re,  z_re);
    vec2 im2   = ddMul(cz_im, cz_im);
    vec2 cross = ddMul(z_re,  cz_im);
    z_re = ddAdd(ddSub(re2, im2), c_re);
    z_im = ddAdd(ddMul2(cross),   c_im);
    if (z_re.x*z_re.x + z_im.x*z_im.x > 4.0) {
      return smoothCount(i, z_re, z_im) / float(u_maxIterations);
    }
  }
  return 1.0;
}

// ── Newton: converges to roots of f(z) = z³ − 1  (float32) ───────────────
// Newton's method converges quickly (quadratically), so deep zoom isn't as
// interesting here as for the escape-time sets. Float32 is adequate.
//
// Complex arithmetic helpers (float32 only, shared by Newton and all new fractals):
vec2 cMul(vec2 a, vec2 b) {
  return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x);
}
vec2 cDiv(vec2 a, vec2 b) {
  float d = dot(b, b);
  return vec2(a.x*b.x + a.y*b.y, a.y*b.x - a.x*b.y) / d;
}
// z² — slight optimisation over cMul(z,z): saves 2 multiplies
vec2 cSq(vec2 z) { return vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y); }

float newton(vec2 z) {
  const vec2 root0 = vec2(1.0,   0.0);
  const vec2 root1 = vec2(-0.5,  0.8660254);
  const vec2 root2 = vec2(-0.5, -0.8660254);
  const float THRESH = 0.001;
  for (int i = 0; i < u_maxIterations; i++) {
    vec2 z2  = cMul(z, z);
    vec2 z3  = cMul(z2, z);
    vec2 num = z3 + z3 + vec2(1.0, 0.0);  // 2z³ + 1
    vec2 den = 3.0 * z2;
    if (dot(den, den) < 1e-10) return -1.0;
    z = cDiv(num, den);
    float speed = 1.0 - float(i) / float(u_maxIterations);
    if (dot(z - root0, z - root0) < THRESH) return 0.0 + speed;
    if (dot(z - root1, z - root1) < THRESH) return 1.0 + speed;
    if (dot(z - root2, z - root2) < THRESH) return 2.0 + speed;
  }
  return -1.0;
}

// ═══════════════════════════════════════════════════════════════════════════
// NEW FRACTAL FUNCTIONS  (float32, except Celtic which uses dd)
// ═══════════════════════════════════════════════════════════════════════════
//
// Smooth-count note: smoothCount(i, vec2(z.x,0), vec2(z.y,0)) works for any
// escape radius — the log₂log₂ formula just phase-shifts the palette slightly
// for larger radii but stays perfectly smooth. Used everywhere below.

// ── Magnet I: z ← ((z² + c − 1) / (2z + c − 2))²  ─────────────────────────
// Rational map from renormalisation theory. The squared ratio creates bulbous
// Mandelbrot-like copies along a shared backbone — resembles a chain of magnets.
// Float32; escape at |z|² > 10 000 (set converges to ±1, not 0).
float magnetI(vec2 c) {
  vec2 z   = vec2(0.0);
  vec2 cm1 = c - vec2(1.0, 0.0);   // c − 1
  vec2 cm2 = c - vec2(2.0, 0.0);   // c − 2
  for (int i = 0; i < u_maxIterations; i++) {
    vec2 num = cSq(z) + cm1;                   // z² + c − 1
    vec2 den = 2.0*z  + cm2;                   // 2z + c − 2
    if (dot(den, den) < 1e-10) break;          // near pole
    z = cSq(cDiv(num, den));
    if (dot(z, z) > 10000.0) {
      return smoothCount(i, vec2(z.x, 0.0), vec2(z.y, 0.0)) / float(u_maxIterations);
    }
  }
  return 1.0;
}

// ── Magnet II: cubic rational map — cubic analogue of Magnet I ──────────────
// Numerator:   z³ + 3(c−1)z + (c−1)(c−2)
// Denominator: 3z² + 3(c−2)z + (c−1)(c−2) + 1
// z_{n+1} = (num/den)²
// Richer structure than Magnet I: three root branches produce more intricate
// self-similar decorations with deeper nested spirals.
float magnetII(vec2 c) {
  vec2 z   = vec2(0.0);
  vec2 cm1 = c - vec2(1.0, 0.0);
  vec2 cm2 = c - vec2(2.0, 0.0);
  vec2 p12 = cMul(cm1, cm2);        // (c−1)(c−2)
  for (int i = 0; i < u_maxIterations; i++) {
    vec2 z2  = cSq(z);
    vec2 z3  = cMul(z2, z);
    vec2 num = z3 + 3.0*cMul(cm1, z) + p12;
    vec2 den = 3.0*z2 + 3.0*cMul(cm2, z) + p12 + vec2(1.0, 0.0);
    if (dot(den, den) < 1e-10) break;
    z = cSq(cDiv(num, den));
    if (dot(z, z) > 10000.0) {
      return smoothCount(i, vec2(z.x, 0.0), vec2(z.y, 0.0)) / float(u_maxIterations);
    }
  }
  return 1.0;
}

// ── Phoenix: z_{n+1} = z_n² + Re(c) + p·z_{n−1},  z₀=(0,0),  z_{−1}=(0,0) ─
// The "memory" term p·z_{prev} stretches the set into ornate feather/wing shapes.
// p = −0.5 is the classic choice; the pixel is c (Mandelbrot-style parameter plane).
float phoenix(vec2 c) {
  vec2  z     = vec2(0.0);
  vec2  zprev = vec2(0.0);
  float p     = -0.5;          // phoenix wing-spread parameter
  for (int i = 0; i < u_maxIterations; i++) {
    vec2 znext = vec2(z.x*z.x - z.y*z.y + c.x + p*zprev.x,
                      2.0*z.x*z.y        + c.y + p*zprev.y);
    zprev = z;
    z     = znext;
    if (dot(z, z) > 4.0) {
      return smoothCount(i, vec2(z.x, 0.0), vec2(z.y, 0.0)) / float(u_maxIterations);
    }
  }
  return 1.0;
}

// ── Celtic variant: z ← |Re(z²)| + i·Im(z²) + c  ───────────────────────────
// Identical to Mandelbrot except the real part of z² is reflected to positive.
// This extra fold creates sea-horse tails that curl outward and a flame-like
// boundary texture not seen in the standard Mandelbrot.
// Uses dd precision (same as Mandelbrot) for deep-zoom capability.
float celtic(vec2 c_re, vec2 c_im) {
  vec2 z_re = vec2(0.0);
  vec2 z_im = vec2(0.0);
  for (int i = 0; i < u_maxIterations; i++) {
    vec2 re2   = ddSub(ddMul(z_re, z_re), ddMul(z_im, z_im));
    vec2 cross = ddMul(z_re, z_im);
    // Celtic twist: |Re(z²)| — negate the dd pair when its hi-part is negative
    if (re2.x < 0.0) re2 = -re2;
    z_re = ddAdd(re2,           c_re);
    z_im = ddAdd(ddMul2(cross), c_im);
    if (z_re.x*z_re.x + z_im.x*z_im.x > 4.0) {
      return smoothCount(i, z_re, z_im) / float(u_maxIterations);
    }
  }
  return 1.0;
}

// ── Transcendental: z_{n+1} = sin(z_n) + c,  z₀ = 0 ────────────────────────
// sin(a+bi) = sin(a)·cosh(b) + i·cos(a)·sinh(b).
// Produces periodic "bubble galaxy" patterns — the filled set repeats with
// period 2π along the real axis and widens into teardrop lobes. Escape at |z|>10.
float sinMap(vec2 c) {
  vec2 z = vec2(0.0);
  for (int i = 0; i < u_maxIterations; i++) {
    z = vec2(sin(z.x)*cosh(z.y), cos(z.x)*sinh(z.y)) + c;
    if (dot(z, z) > 100.0) {
      return float(i) / float(u_maxIterations);
    }
  }
  return 1.0;
}

// ── Transcendental: z_{n+1} = eᶻⁿ + c,  z₀ = 0 ─────────────────────────────
// e^(a+bi) = e^a·(cos(b) + i·sin(b)).
// The "explosion" fractal: infinite parallel fingers radiating from a crescent-
// shaped boundary. Escapes when Re(z) becomes large (exponential blowup) or
// |z|² > 1000. Input clamped to prevent GPU float overflow.
float expMap(vec2 c) {
  vec2 z = vec2(0.0);
  for (int i = 0; i < u_maxIterations; i++) {
    float er = exp(clamp(z.x, -10.0, 20.0));   // clamp prevents fp overflow
    z = vec2(er*cos(z.y), er*sin(z.y)) + c;
    if (z.x > 20.0 || dot(z, z) > 1000.0) {
      return float(i) / float(u_maxIterations);
    }
  }
  return 1.0;
}

// ── Rational map: z_{n+1} = z_n² + c + λ/z_n²  (λ = 0.25) ─────────────────
// The 1/z² term (the "Blaschke perturbation") creates copies of the Julia set
// around the origin separated by an annular "McMullen domain". z₀ = (0.5,0)
// avoids the pole. Escape at |z|² > 100.
float rational(vec2 c) {
  float lambda = 0.25;
  vec2 z = vec2(0.5, 0.0);        // offset start avoids pole at origin
  for (int i = 0; i < u_maxIterations; i++) {
    vec2  z2  = cSq(z);
    float d2  = dot(z2, z2);
    if (d2 < 1e-10) break;        // near pole, abort
    vec2 zinv2 = vec2(z2.x, -z2.y) / d2;   // 1/z² = conj(z²)/|z²|²
    z = z2 + c + lambda * zinv2;
    if (dot(z, z) > 100.0) {
      return float(i) / float(u_maxIterations);
    }
  }
  return 1.0;
}

// ═══════════════════════════════════════════════════════════════════════════
// COLOUR PALETTES
// ═══════════════════════════════════════════════════════════════════════════

vec3 hsv2rgb(float h, float s, float v) {
  vec3 p = abs(fract(vec3(h) + vec3(1.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
  return v * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), s);
}

vec3 colorUltraSmooth(float t) {
  if (t >= 1.0) return vec3(0.0);
  float brightness = 0.85 + 0.15*sin(t * 62.8);
  return hsv2rgb(fract(t * 8.0), 0.75, brightness);
}
vec3 colorFire(float t) {
  if (t >= 1.0) return vec3(0.0);
  float u = 1.0 - t;
  return vec3(clamp(u*3.0, 0.0, 1.0), clamp(u*3.0-1.0, 0.0, 1.0), clamp(u*3.0-2.0, 0.0, 1.0));
}
vec3 colorElectric(float t) {
  if (t >= 1.0) return vec3(0.0);
  float u = 1.0 - t;
  return vec3(clamp(u*3.0-2.0, 0.0, 1.0), clamp(u*2.0-0.5, 0.0, 1.0), clamp(u*3.0, 0.0, 1.0));
}
vec3 colorGrayscale(float t) {
  if (t >= 1.0) return vec3(0.0);
  return vec3(sqrt(1.0 - t));
}
vec3 colorRainbow(float t) {
  if (t >= 1.0) return vec3(0.0);
  return hsv2rgb(fract(t * 5.0 + 0.6), 0.9, 1.0 - t*0.3);
}

// ── Shark Blue Metallic ───────────────────────────────────────────
// Deep navy → rich metallic blue → icy electric highlight.
// ring: gentle brightness oscillation creates banding without changing hue.
// pow curve biases luminance so boundary regions (high t) bloom brightest.
vec3 colorSharkBlue(float t) {
  if (t >= 1.0) return vec3(0.0);
  float ring = 0.5 + 0.5 * sin(t * 47.1);
  float v    = clamp(pow(t, 0.55) * (0.82 + 0.18 * ring), 0.0, 1.0);
  // 3-stop: near-black navy → rich Shark Blue → icy white-blue
  if (v < 0.55) return mix(vec3(0.00, 0.01, 0.06), vec3(0.06, 0.25, 0.62), v / 0.55);
  return         mix(vec3(0.06, 0.25, 0.62), vec3(0.72, 0.89, 1.00), (v - 0.55) / 0.45);
}

// ── GT Silver Metallic ────────────────────────────────────────────
// Cold black → steel grey → bright specular silver-white.
// Slightly cool (blue-grey tint) to evoke brushed aluminium.
vec3 colorGTSilver(float t) {
  if (t >= 1.0) return vec3(0.0);
  float ring = 0.5 + 0.5 * sin(t * 47.1);
  float v    = clamp(pow(t, 0.55) * (0.82 + 0.18 * ring), 0.0, 1.0);
  // 3-stop: near-black → steel grey → bright specular white
  if (v < 0.50) return mix(vec3(0.01, 0.01, 0.02), vec3(0.30, 0.33, 0.36), v / 0.50);
  return         mix(vec3(0.30, 0.33, 0.36), vec3(0.92, 0.93, 0.95), (v - 0.50) / 0.50);
}

// ── Guards Red (Carmine) ──────────────────────────────────────────
// Near-black → deep signal red → orange-white boundary flare.
// The warm edge stops it feeling flat — classic racing look.
vec3 colorCarmine(float t) {
  if (t >= 1.0) return vec3(0.0);
  float ring = 0.5 + 0.5 * sin(t * 47.1);
  float v    = clamp(pow(t, 0.55) * (0.82 + 0.18 * ring), 0.0, 1.0);
  // 3-stop: near-black red → Guards Red → orange-white flare
  if (v < 0.60) return mix(vec3(0.04, 0.00, 0.00), vec3(0.72, 0.04, 0.04), v / 0.60);
  return         mix(vec3(0.72, 0.04, 0.04), vec3(1.00, 0.82, 0.62), (v - 0.60) / 0.40);
}

// ── Bernstein — the classic deep-zoom Mandelbrot palette ──────────────────
// Uses cubic Bernstein basis polynomials to trace a smooth arc:
//   black → midnight blue → cobalt → electric cyan → white → black
// The arc repeats every 1/6 of t, so each "ring" of the fractal gets its
// own pass through the full colour progression. Because Bernstein(0) =
// Bernstein(1) = 0 the repeats meet at black — no hard edges.
vec3 colorBernstein(float t) {
  if (t >= 1.0) return vec3(0.0);
  float u = fract(t * 6.0);               // 6 full cycles across escape range
  float r = 9.0   * (1.0-u) * u*u*u;
  float g = 15.0  * (1.0-u)*(1.0-u) * u*u;
  float b = 8.5   * (1.0-u)*(1.0-u)*(1.0-u) * u;
  return clamp(vec3(r, g, b), 0.0, 1.0);
}

// ── Twilight — deep purple → magenta → amber → pale gold ─────────────────
// Warm-cool contrast makes fine boundary detail pop, especially on Julia sets.
vec3 colorTwilight(float t) {
  if (t >= 1.0) return vec3(0.0);
  float ring = 0.5 + 0.5 * sin(t * 47.1);
  float v    = clamp(pow(t, 0.55) * (0.82 + 0.18 * ring), 0.0, 1.0);
  if (v < 0.33) return mix(vec3(0.02, 0.00, 0.05), vec3(0.25, 0.00, 0.55), v / 0.33);
  if (v < 0.66) return mix(vec3(0.25, 0.00, 0.55), vec3(0.90, 0.35, 0.10), (v-0.33)/0.33);
  return         mix(vec3(0.90, 0.35, 0.10), vec3(1.00, 0.95, 0.70), (v-0.66)/0.34);
}

// ── Lava — molten black → deep red → bright orange → pale yellow ──────────
// High contrast; works especially well with Burning Ship and Tricorn.
vec3 colorLava(float t) {
  if (t >= 1.0) return vec3(0.0);
  float ring = 0.5 + 0.5 * sin(t * 47.1);
  float v    = clamp(pow(t, 0.55) * (0.82 + 0.18 * ring), 0.0, 1.0);
  if (v < 0.40) return mix(vec3(0.03, 0.00, 0.00), vec3(0.65, 0.05, 0.00), v / 0.40);
  if (v < 0.75) return mix(vec3(0.65, 0.05, 0.00), vec3(1.00, 0.50, 0.05), (v-0.40)/0.35);
  return         mix(vec3(1.00, 0.50, 0.05), vec3(1.00, 0.98, 0.80), (v-0.75)/0.25);
}

vec3 applyColorScheme(float t) {
  if      (u_colorScheme == 0) return colorUltraSmooth(t);
  else if (u_colorScheme == 1) return colorFire(t);
  else if (u_colorScheme == 2) return colorElectric(t);
  else if (u_colorScheme == 3) return colorGrayscale(t);
  else if (u_colorScheme == 4) return colorRainbow(t);
  else if (u_colorScheme == 5) return colorSharkBlue(t);
  else if (u_colorScheme == 6) return colorGTSilver(t);
  else if (u_colorScheme == 7) return colorCarmine(t);
  else if (u_colorScheme == 8) return colorBernstein(t);
  else if (u_colorScheme == 9) return colorTwilight(t);
  else                         return colorLava(t);
}
vec3 colorNewton(float v) {
  if (v < 0.0) return vec3(0.02);
  int   root  = int(floor(v));
  float speed = fract(v);
  vec3 hues[3] = vec3[3](vec3(1.0,0.2,0.15), vec3(0.2,0.9,0.3), vec3(0.2,0.4,1.0));
  vec3 base = (root < 3) ? hues[root] : vec3(1.0);
  return base * (0.3 + 0.7*pow(speed, 0.4));
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
void main() {
  // Compute the dd complex coordinate for this pixel
  vec2 c_re, c_im;
  pixelToComplexDD(c_re, c_im);

  if (u_fractalType == 3) {
    // Newton uses float32 — drop to hi parts
    fragColor = vec4(colorNewton(newton(vec2(c_re.x, c_im.x))), 1.0);
  } else {
    float t;
    if      (u_fractalType == 0) t = mandelbrot(c_re, c_im);
    else if (u_fractalType == 1) t = julia(c_re, c_im);        // z₀ = pixel dd, c = juliaC
    else if (u_fractalType == 2) t = burningShip(c_re, c_im);
    else if (u_fractalType == 4) t = tricorn(c_re, c_im);
    else if (u_fractalType == 5) t = custom(c_re, c_im);
    else if (u_fractalType == 9) t = celtic(c_re, c_im);       // dd precision
    else {
      // Float32 fractals — extract hi-part of the dd pixel coordinate
      vec2 c = vec2(c_re.x, c_im.x);
      if      (u_fractalType == 6)  t = magnetI(c);
      else if (u_fractalType == 7)  t = magnetII(c);
      else if (u_fractalType == 8)  t = phoenix(c);
      else if (u_fractalType == 10) t = sinMap(c);
      else if (u_fractalType == 11) t = expMap(c);
      else                          t = rational(c);            // type 12
    }
    fragColor = vec4(applyColorScheme(t), 1.0);
  }
}
`;
