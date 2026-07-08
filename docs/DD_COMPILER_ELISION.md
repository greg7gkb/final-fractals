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
rounding — and that is precisely why a fast-math compiler destroys it. The key realisation
is that **the compiler and the hardware are using two different models of arithmetic**, and
double-double lives entirely in the gap between them.

### 2.1 The compiler optimises with real-number algebra, not float algebra

Every optimiser rewrites expressions using identities like `x - x = 0`, `(a + b) - a = b`,
and associativity. Those identities are **true for real numbers and false for floating
point**, because a float operation *rounds* its result before the next operation sees it.
Double-double exists precisely to capture that rounding — so an optimiser that assumes it
away deletes the payload.

Ask the compiler to simplify `e` with real-number algebra, substituting `s = a + b`:

```
v         = s - a       = (a + b) - a = b
s - v     = (a + b) - b = a
a - (s-v) = a - a       = 0
b - v     = b - b       = 0
e         = 0 + 0       = 0
```

The proof is airtight *in real arithmetic*, so the optimiser concludes `e ≡ 0` and removes
the whole computation. It is not being reckless — within the model it was handed, the
operations genuinely are redundant. From its point of view they never made a difference to
the output at all.

### 2.2 Where the model diverges from the hardware

Run the same code in actual `float32` with `a = 1.0`, `b = 2⁻³⁰` (≈ 9.3e-10) — far below
`ulp(1.0) = 2⁻²³ ≈ 1.2e-7`:

| step | real-number value | **actual float32 value** |
|------|-------------------|--------------------------|
| `s = a + b`   | 1.0000000009… | **1.0** — `b` rounds away entirely |
| `v = s - a`   | `b` = 2⁻³⁰ | **0.0** — `1.0 − 1.0` |
| `a - (s - v)` | 0 | 0.0 |
| `b - v`       | 0 | **2⁻³⁰** |
| `e`           | **0** | **2⁻³⁰** ✅ |

Executed honestly, TwoSum recovers `e = 2⁻³⁰` — the exact bit of `b` that didn't fit into
`s`. That is the whole payload. The compiler's proof hinges on one illegal step:

> `v = (a + b) − a = b`

True in real numbers. But in `float32`, `a + b` **already rounded to `1.0`** before the
subtraction, so `(a+b) − a` is `0`, not `b`. The optimiser substituted the *un-rounded*
value of `s` back in — it "forgot" that `s` had been rounded. That single substitution
collapses `e` to `0`, and the output becomes bit-for-bit identical to plain float32.

### 2.3 Why the compiler was allowed to do this

Two things stacked together:

1. **Fast-math is the GPU default.** GLSL's precision guarantees are weak, and ANGLE→Metal
   (like most shader toolchains) enables aggressive float optimisation: it is explicitly
   permitted to treat `+` and `*` as associative/distributive — i.e. to reason as if
   rounding does not occur — in exchange for speed. The strict IEEE-754 reassociation rules
   that would forbid this are not promised on that path. (This is exactly why WGSL/WebGPU
   fixes it: it *mandates* strict semantics, so the rewrite becomes illegal — see §5.)
2. **A static optimiser cannot see the runtime difference.** It does not execute the shader
   and diff the pixels; it transforms the expression tree with rules it believes preserve
   value. Under its assumed model they *do*. Nothing in an algebraic-simplification pass
   models per-operation rounding, so there is no signal that this particular rewrite
   mattered. The difference you wanted exists only at runtime — invisible to the pass that
   deleted it.

### 2.4 The three failure modes

On Apple's Metal backend (via ANGLE), three distinct forms of this simplification were
found, and each had to be blocked separately:

| # | Failure mode | What the compiler did |
|---|--------------|-----------------------|
| 1 | **Algebraic reassociation** | Collapsed TwoSum's `(a - (s - v)) + (b - v)` to `0`, and the Veltkamp split's `t - (t - a)` to `a`. |
| 2 | **Symbolic substitution** | Substituted `s = a + b` back in, turning `s - a` into `(a + b) - a` → folded to `b`. But in `float32`, `(a+b) - a` rounds to `0`, not `b`, when `|b| ≪ ulp(a)` (the worked example above). |
| 3 | **No-op elision** | Recognised a pure bitcast `uintBitsToFloat(floatBitsToUint(x))` as an identity and constant-folded it away — so an un-salted `launder()` did nothing. |

> **In one line:** double-double is a program whose entire purpose is to *measure*
> floating-point rounding error; a fast-math optimiser's entire purpose is to *pretend
> rounding error doesn't exist*. They are directly at odds — so the optimiser "helpfully"
> deleted the only thing the code existed to compute.

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
