# Migration plan: WebGL 2 → WebGPU (drop WebGL entirely)

**Status:** Planned, not started.
**Estimated effort:** 1–2 focused days.
**Owner:** TBD.

---

## 1. Motivation

The current WebGL 2 implementation hit a precision wall that took several iterations to diagnose: GLSL ES 3.00 has no `precise` qualifier, and ANGLE's Metal backend on macOS aggressively reassociates expressions like `(a + b) - a → b`. That rewrite silently destroys the dd error-reconstruction in TwoSum / TwoProd, collapsing dd to bit-identical f32 output. The current shipping fix is a `launder()` helper that hides each intermediate value behind a `uint↔float` bitcast XORed against a uniform "salt" — opaque to the compiler, runtime-trivial, and verified working by `src/dd/validate.ts`.

WGSL (WebGPU's shading language) **specifies strict IEEE-754 semantics by default**: `(a + b) - a` evaluates exactly as written, no reassociation. The launder workaround becomes unnecessary, the dd code becomes ~1/3 the size, and a whole class of future regression risk goes away. WebGPU also unlocks **compute shaders**, which is the prerequisite for ever implementing perturbation theory (the only path past dd's iteration-amplification ceiling — see `README.md §Double-double precision`).

---

## 2. Goal

Replace the WebGL 2 path with a WebGPU-only renderer. Drop the WebGL 2 code (no fallback). Match the current feature set 1:1: all 13 fractals, all 11 palettes, dd precision on the five classical sets, runtime validator, ?diag panel, image capture, pan/zoom/rotate, grid overlay.

### Success criteria
- All 13 fractals render bit-identically to within smooth-count rounding noise compared to the current main branch.
- `src/dd/validate.ts` (ported to WebGPU) returns 9/9 PASS with the dd primitives written naturally (no `launder`, no `u_ddSalt`).
- Deep-zoom comparison: at the (-0.562203, -0.642817) zoom 6 × 10⁵× view, the new build's pixel output is *not* bit-identical to f32-only (i.e. dd is actually doing work, just like main is today).
- FPS at 4K on Mandelbrot deep zoom is within ±20% of the current build.
- App load + first-render time under 500 ms on M-series hardware.

### Out of scope
- Perturbation theory itself (separate plan; this migration is the *enabler*).
- Adaptive precision (f32 at shallow zoom, dd at deep zoom) — defer until after the migration if FPS demands it.
- WebGL 2 fallback for older browsers. Hard-require WebGPU.

---

## 3. Browser-support floor

As of 2026-05-12:

| Browser | WebGPU since | Notes |
|---|---|---|
| Chrome / Edge | 113 (May 2023) | Desktop + Android. |
| Safari | 17.4 (Mar 2024) | macOS + iOS. |
| Firefox | 121 (Dec 2023) | macOS/Windows immediately; Linux mid-2024. |

Hard-fail on missing `navigator.gpu` with a user-facing message that explains the requirement and links to https://caniuse.com/webgpu.

---

## 4. Phased plan

Phases are designed so each one ends with a working build (no half-state on `main` ever). Recommend doing all of this on a feature branch (`dev/webgpu`) with the existing `dev/f32-only` branch retained as a comparison anchor.

### Phase 0 — Setup (≈30 min)
- Add `@webgpu/types` to devDependencies.
- Add `"lib": ["DOM", "ES2022", "WebGPU"]` (or include `@webgpu/types` triple-slash) to `tsconfig.json`.
- Create `dev/webgpu` branch from `main`.
- Sanity check: in a scratch file, call `navigator.gpu.requestAdapter()` and log the result on each target browser/device.

### Phase 1 — Shader port (≈4 hours)
Translate `src/renderer/shaders.ts` → `src/renderer/shaders.wgsl.ts` (or split into multiple `.wgsl` files imported as strings).

Mechanical translation table:

| GLSL ES 3.00 | WGSL |
|---|---|
| `precision highp float;` | (gone — WGSL uses explicit types) |
| `vec2`, `vec3`, `vec4` | `vec2<f32>`, etc. |
| `float`, `int`, `uint` | `f32`, `i32`, `u32` |
| `uniform vec2 u_x;` | uniform-buffer struct field |
| `in vec2 v_uv;` | function parameter with `@location(0)` |
| `out vec4 fragColor;` | function return with `@location(0)` |
| `gl_FragCoord` | `@builtin(position)` parameter |
| `vec2(a, b)` constructor | `vec2<f32>(a, b)` |
| `mix(a, b, t)` | `mix(a, b, t)` (same) |
| `if/else if` chain | `switch` is now available — clearer for `u_fractalType` dispatch |
| `floatBitsToUint(x)` | `bitcast<u32>(x)` |
| `uintBitsToFloat(u)` | `bitcast<f32>(u)` |

**Strip the launder machinery during translation:**
- Delete `launder()` function and `u_ddSalt` uniform.
- Restore `twoSum`, `twoProd`, `ddAdd`, `ddSub`, `ddAddF`, `ddMul` to their natural pre-launder forms (see git log entry "DD: launder() bitcasts to defeat algebraic reassociation" — revert the bodies, keep the comments noting the WebGL story for future archaeology).
- Restore `splitF` to the classical Veltkamp `t - (t - a)` if desired (or keep the bit-mask version — both work in WGSL).

Per-fractal functions (`mandelbrot`, `julia`, `burningShip`, `tricorn`, `newton`, `custom`, `magnetI`, `magnetII`, `phoenix`, `celtic`, `sinMap`, `expMap`, `rational`) and per-palette functions (11 of them) are nearly 1:1 — same arithmetic, just retyped.

Vertex shader: replace the index-based array trick with `@builtin(vertex_index)`:
```wgsl
@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}
```

### Phase 2 — Renderer port (≈3 hours)
Replace `src/renderer/WebGLRenderer.ts` with `src/renderer/WebGPURenderer.ts` exposing the same constructor signature and `render(camera, uniforms)` method so `main.ts` changes minimally.

Concrete steps:
1. **Adapter / device acquisition** (async). Wrap in a factory: `WebGPURenderer.create(canvas): Promise<WebGPURenderer>`.
2. **Canvas context configuration**: `canvas.getContext('webgpu')`, `ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' })`.
3. **Uniform buffer**: one buffer containing all the existing uniforms packed into a struct. Watch alignment (vec2 must align to 8 bytes, vec4/struct fields to 16). Use `device.createBuffer({ size, usage: UNIFORM | COPY_DST })`.
4. **Pipeline**: `device.createRenderPipeline` with the WGSL vertex + fragment modules, triangle list primitive, no depth.
5. **Bind group**: binds the uniform buffer to the WGSL `@group(0) @binding(0)`.
6. **Render loop**: per-frame, write uniform buffer via `device.queue.writeBuffer`, then encode + submit a render pass that draws 3 vertices.

`main.ts` change: `new WebGLRenderer(canvas)` → `await WebGPURenderer.create(canvas)`. The render loop becomes async-aware (move the rAF body so the initial promise resolves before the first frame).

### Phase 3 — Validator port (≈2 hours)
Port `src/dd/validate.ts`.

WebGPU readback is async (`mapAsync`) and the simplest path is:
1. Create a 1×N R32G32B32A32-float storage texture (or storage buffer).
2. Compile a tiny compute shader that runs the test cases (one workgroup invocation per case) and writes results to the storage buffer.
3. Copy the storage buffer to a CPU-mappable buffer, `mapAsync`, read back as `Float32Array`.

Or stick with the render-shader approach (1×N texture target). Both work; the compute path is cleaner because there's no rasterisation involved.

The JS reference (`_twoSum`, `_split`, etc.) stays the same — those are the float64 ground truth. With launder gone from GLSL, the JS `_split` should revert to the Veltkamp form too if we revert the GLSL split.

### Phase 4 — Cleanup (≈1 hour)
- Delete `src/renderer/WebGLRenderer.ts`, the WebGL-specific bits of `shaders.ts`.
- Delete `u_ddSalt` references throughout.
- Update `README.md` and `ARCHITECTURE.md` to say "WebGPU" everywhere.
- Update the "Browser requirements" section to list WebGPU minimums.
- Drop `dev/f32-only` workflow (or port that too — could be useful as a permanent regression-comparison anchor; decide before delete).

### Phase 5 — Verification (≈1 hour)
- Run validator: 9/9 PASS with natural dd primitives.
- Visual diff between WebGPU main and current WebGL main at several deep-zoom views — confirm visually identical.
- FPS sweep: Mandelbrot zoom 1×, 10³×, 10⁵×, 10⁶× on retina 4K — record numbers, compare to current WebGL.
- Capture image: verify PNG export still works (it uses `canvas.toBlob`, which works on WebGPU canvases the same way).
- Cross-browser test: Chrome, Safari 17.4+, Firefox.

---

## 5. Specific concerns / known gotchas

- **Uniform buffer alignment in WGSL is strict.** `vec2<f32>` must align to 8 bytes; structs to 16. The current GLSL packs uniforms loosely; the WGSL struct will need explicit padding fields. Don't trust manual offsets — use [WebGPU's uniform layout rules](https://www.w3.org/TR/WGSL/#alignment-and-size) or generate the struct from a TS type.
- **Canvas size and DPR**: WebGPU uses `canvas.width / canvas.height` directly for the swap-chain texture size. Re-configure the context on resize, same pattern as current `resizeCanvas()`.
- **No automatic mipmapping** in WebGPU — irrelevant here (no textures), but worth knowing.
- **`canvas.toBlob` works** with WebGPU canvases on all current browsers — verified May 2025. Image capture flow shouldn't need changes.
- **Async first frame**: device acquisition is async, so the page is briefly black before first render. Consider showing a loading indicator (or just live with it — it's ~50ms).
- **Compute shader use is optional** for this migration. Skip it. The validator can use a render pipeline just like now.
- **Apple Silicon WebGPU implementation quirk**: as of mid-2025, Safari's WebGPU on M-series has occasional pipeline-compile stalls on first use. Pre-warm the pipeline at startup if first-frame latency matters.

---

## 6. Decisions to make before starting

- **Hard-require WebGPU or fall back to WebGL 2?** Recommend hard-require (cleaner end state; matches goal of "drop WebGL entirely"). Failure mode: friendly message on `<canvas>` saying "WebGPU required; tested on Chrome 113+ / Safari 17.4+ / Firefox 121+" with the caniuse link.
- **Keep `dev/f32-only` branch or delete?** Recommend keep as a permanent reference for "what does pure f32 look like" — useful for future debugging and educational value. Update its workflow to also use WebGPU once the migration lands.
- **Single fragment-shader file or split per fractal?** The current monolith works; splitting would be ~12 files of ≤50 lines each. Trade-off is build complexity vs. readability. Recommend keep monolithic.

---

## 7. References

- WGSL spec: https://www.w3.org/TR/WGSL/
- WebGPU spec: https://www.w3.org/TR/webgpu/
- Migration guide (WebGL → WebGPU): https://developer.chrome.com/blog/from-webgl-to-webgpu
- `@webgpu/types`: https://www.npmjs.com/package/@webgpu/types
- Why we have to launder today: see `src/renderer/shaders.ts` comment on `launder()` (the `DD_PRIMITIVES_GLSL` block) — keep that comment in the codebase even after migration, as a historical note.

---

## 8. Definition of done

- [ ] All 9 validator tests pass on Chrome, Safari, Firefox without `launder()` in the source.
- [ ] Visual diff vs. current main: imperceptible at every fractal × palette × zoom-depth combination spot-checked.
- [ ] FPS within ±20% of WebGL at 4K Mandelbrot deep zoom.
- [ ] `README.md` and `ARCHITECTURE.md` updated.
- [ ] `dev/webgpu` branch merged to `main`; WebGL renderer and its workflow inputs deleted.
- [ ] `?diag` URL param still works; chip still surfaces on validation failure.
