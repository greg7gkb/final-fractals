# Double-Double Compiler Elision — the `launder()` workaround

**Status:** resolved (workaround in place) · **Discovered:** 2026-05-12 · **Platform:** Apple Metal-based WebGL2 (ANGLE) on macOS

This documents a class of bug where the GPU shader compiler *silently deletes* the
double-double (dd) precision arithmetic, producing output bit-for-bit identical to
plain `float32` with **no compile error and no visible warning**. It explains the
symptom, the root cause, the fix (`launder()` + salt + bit-mask split), and how the
app now detects a regression at runtime.

For the dd *technique* itself (why we use it, TwoSum/TwoProd, zoom ceilings), see
[`ARCHITECTURE.md` §3](../ARCHITECTURE.md#3-double-double-precision-for-deep-zoom)
and the "Double-double precision" section of [`README.md`](../README.md#double-double-precision).

---

## 1. Symptom

The five dd fractals (Mandelbrot, Julia, Burning Ship, Tricorn, Celtic) degraded into
blocky rectangles at the *same* zoom depth as the float32 fractals — around ~10⁻⁵ — even
though the dd code was present, compiled cleanly, and ran. The dd machinery was executing
but producing results **identical to pure f32**: the extra-precision `lo` term came out as
`0` everywhere it mattered.

Crucially there was **no error signal**. The shader compiled, linked, and rendered. The
only way to notice was to compare against a float64 reference and see that the `lo`
component had been zeroed.

## 2. Root cause

Double-double arithmetic is built on *error-free transformations* — algebraic identities
that recover the rounding error a single `float32` operation throws away. The canonical
TwoSum error term is:

```glsl
e = (a - (s - v)) + (b - v)    // where s = a + b, v = s - a
```

In exact real arithmetic this expression is `0`. Its entire value comes from `float32`
rounding: `s - a` does **not** equal `b`, and that discrepancy *is* the error we want to
capture. This is exactly the kind of expression a **fast-math / reassociating compiler
destroys**, because under real-number algebra it can prove the result is zero (or that the
split is a no-op) and simplify it away.

On Apple's Metal backend (via ANGLE), the GLSL→native compiler was applying these
real-number simplifications to the shader. Three distinct failure modes were found, and
each had to be blocked separately:

| # | Failure mode | What the compiler did |
|---|--------------|-----------------------|
| 1 | **Algebraic reassociation** | Collapsed TwoSum's `(a - (s - v)) + (b - v)` to `0`, and the Veltkamp split's `t - (t - a)` to `a`. |
| 2 | **Symbolic substitution** | Substituted `s = a + b` back in, turning `s - a` into `(a + b) - a` → folded to `b`. But in `float32`, `(a+b) - a` rounds to `0`, not `b`, when `|b| ≪ ulp(a)`. |
| 3 | **No-op elision** | Recognised a pure bitcast `uintBitsToFloat(floatBitsToUint(x))` as an identity and constant-folded it away — so an un-salted `launder()` did nothing. |

## 3. The fix

### 3.1 `launder()` — an opaque commit point

Insert a `uint↔float` bitcast at each intermediate "commit point". On the integer side the
compiler cannot reason about float identities, so it must treat the value as opaque and is
forced to *commit* the subtraction before the next operation — reassociation across it
becomes impossible. On the GPU this is a register reinterpretation: zero machine code.

### 3.2 Salt the bitcast (defeat mode 3)

A pure bitcast is a provable no-op, and the compiler saw through it. XOR-ing against a
uniform whose value the compiler cannot know at compile time makes the bitcast
**un-foldable**. JS uploads `u_ddSalt = 0`, so XOR-with-zero is a runtime no-op — the only
cost is one XOR per `launder()` call (~3 per TwoSum).

```glsl
uniform highp uint u_ddSalt;              // JS sets this to 0, once
float launder(float x) {
  return uintBitsToFloat(floatBitsToUint(x) ^ u_ddSalt);
}
```

### 3.3 Launder *every* intermediate, including `s` (defeat modes 1 & 2)

Laundering `v`, `sv`, and `bv` individually was **not enough**. Two extra holes had to be
plugged:

- **`s` itself must be laundered.** Otherwise the compiler substitutes `s = a + b` back into
  `launder(s - a)` (mode 2). Laundering `s` blocks the substitution at the source.
- **The `a - sv` sub must be laundered.** Even with `v`/`sv`/`bv` laundered, the final
  `(a - sv) + bv` was being reassociated into `a + (bv - sv)`, which collapses to `0` when
  `|b| ≪ ulp(a)`. Laundering `a - sv` forces that subtraction to commit before the final add.

The resulting TwoSum (`src/renderer/shaders.ts`):

```glsl
vec2 twoSum(float a, float b) {
  float s    = launder(a + b);
  float v    = launder(s - a);
  float sv   = launder(s - v);
  float bv   = launder(b - v);
  float a_sv = launder(a - sv);   // commit before the final add
  float e    = a_sv + bv;
  return vec2(s, e);
}
```

TwoProd needs `launder()` on its running cross-term sum (so it can't be merged with
`p = a*b`), but its final form `t3 + as.y*bs.y` has only two operands and is already
irreducible — no extra laundering needed there.

### 3.4 Bit-mask split instead of Veltkamp (structurally immune)

The classical Veltkamp split `hi = t - (t - a)` is another algebraic identity the compiler
simplified to `a` (mode 1). It was replaced with a direct bit-mask that zeroes the bottom 12
mantissa bits — genuine bit-manipulation work with no float identity to exploit, so it is
structurally immune to reassociation (and slightly faster):

```glsl
vec2 splitF(float a) {
  float hi = uintBitsToFloat(floatBitsToUint(a) & 0xFFFFF000u);
  return vec2(hi, a - hi);
}
```

The JS float64 reference in the validator mirrors this same bit-mask (`_split` in
`src/dd/validate.ts`) so expected values still match GPU output.

## 4. Detection — runtime validator

Because the failure is silent, `src/dd/validate.ts` runs at every app load:

1. Compiles a tiny test shader using the **exact same** `DD_PRIMITIVES_GLSL` string the main
   shader uses (no parallel reimplementation — the validator must test the shipping code).
2. Renders nine test cases (one per dd primitive path) to a 1×1 float32 framebuffer and reads
   them back via `gl.readPixels`.
3. Compares each against a float64 reference computed with `Math.fround` to model GLSL
   semantics faithfully.
4. **Critical assertion:** when the reference says `lo ≠ 0`, the actual `lo` must share sign and
   order of magnitude. Compiler-elided dd surfaces as `lo = 0` — exactly what this catches.

Results are logged to the console as a paste-friendly text block on every load (info on
success, warn on failure), so remote/cross-device reports stay useful.

### UI surfacing

The title-bar precision chip has three states (`src/main.ts`, `src/dd/diagPanel.ts`):

| Chip | Meaning |
|------|---------|
| **DD** (green) | Fractal uses dd, validator passed. |
| **f32** (orange) | Fractal *wants* dd, but the GPU compiler killed it — this bug is back. |
| **f32** (grey) | Fractal uses f32 by design (e.g. Newton). Not a regression. |

Clicking the chip toggles a diagnostic panel (also reachable via `?diag`) that lists every
test, its rationale, and expected vs. actual `(hi, lo)` — useful for diagnosing what a
driver on someone else's machine is doing.

## 5. Fragility & the long-term fix

This workaround is **empirical**, not guaranteed. It defeats the specific simplifications
this compiler version performs; a future driver could find a new reassociation the current
`launder()` placement doesn't block. That is precisely why the runtime validator exists — it
turns a silent, invisible regression into a visible orange chip.

The durable fix is **WebGPU / WGSL**, whose strict IEEE-754 semantics forbid this class of
reassociation, letting us drop `launder()` and the salt entirely. See
[`docs/MIGRATION_WEBGPU.md`](MIGRATION_WEBGPU.md).

## 6. Commit trail

The fix landed as a sequence of commits on 2026-05-12 (each blocking one failure mode):

| Commit | What it did |
|--------|-------------|
| `a723a5f` | Add runtime GPU validation of dd primitives — the discovery + safety net. |
| `5139e89` | `launder()` bitcasts to defeat algebraic reassociation; bit-mask split replaces Veltkamp. |
| `bae1c89` | Salt `launder()` with a uniform XOR to defeat no-op elision (mode 3). |
| `bd63a96` | Launder the `a - sv` intermediate to block final-add reassociation (mode 1). |
| `831a13a` | Also launder `s` to block symbolic substitution (mode 2). |
| `65cd46b` | Precision indicator: three-state chip, toggleable diag panel. |

## 7. Files involved

| File | Role |
|------|------|
| `src/renderer/shaders.ts` | `DD_PRIMITIVES_GLSL` — `launder()`, `twoSum`, `splitF`, `twoProd`. |
| `src/renderer/WebGLRenderer.ts` | Uploads `u_ddSalt = 0`. |
| `src/dd/validate.ts` | Runtime validator + float64 reference. |
| `src/dd/diagPanel.ts` | Diagnostic overlay. |
| `src/main.ts` | Precision chip state + tooltips. |
