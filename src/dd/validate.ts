/**
 * validate.ts — runtime GPU validation of the dd primitives
 *
 * Compiles a small test shader containing the EXACT same GLSL primitives that
 * the main fragment shader uses (via DD_PRIMITIVES_GLSL), runs a handful of
 * known inputs on the GPU, reads the results back via a float32 framebuffer,
 * and compares them to expected values computed in float64 on the CPU.
 *
 * The goal is to catch the case where the GPU driver / GLSL→native compiler
 * algebraically simplifies away TwoSum / TwoProd — turning the dd machinery
 * into a no-op without any compile error. That's not a hypothetical: we found
 * exactly this on Apple's Metal-based WebGL2 path in May 2026, and that's
 * the regression class this validator exists to surface.
 */
import { DD_PRIMITIVES_GLSL } from '../renderer/shaders.js';

// ─────────────────────────────────────────────────────────────────────────────
// Float32-emulating helpers — used only to compute expected values.
// We never call them from the application or from tests; they exist solely to
// produce the ground-truth values we compare GPU output against.
// ─────────────────────────────────────────────────────────────────────────────
const f32 = Math.fround;

function _twoSum(a: number, b: number): [number, number] {
  const s = f32(a + b);
  const v = f32(s - a);
  const e = f32(f32(a - f32(s - v)) + f32(b - v));
  return [s, e];
}

function _split(a: number): [number, number] {
  const t  = f32(4097.0 * a);
  const hi = f32(t - f32(t - a));
  return [hi, f32(a - hi)];
}

function _twoProd(a: number, b: number): [number, number] {
  const p = f32(a * b);
  const [asx, asy] = _split(a);
  const [bsx, bsy] = _split(b);
  const t1 = f32(f32(asx * bsx) - p);
  const t2 = f32(t1 + f32(asx * bsy));
  const t3 = f32(t2 + f32(asy * bsx));
  const e  = f32(t3 + f32(asy * bsy));
  return [p, e];
}

function _ddAdd(ax: number, ay: number, bx: number, by: number): [number, number] {
  const [sx, sy0] = _twoSum(ax, bx);
  const sy = f32(sy0 + f32(ay + by));
  return _twoSum(sx, sy);
}

function _ddSub(ax: number, ay: number, bx: number, by: number): [number, number] {
  return _ddAdd(ax, ay, -bx, -by);
}

function _ddAddF(ax: number, ay: number, b: number): [number, number] {
  const [sx, sy0] = _twoSum(ax, b);
  const sy = f32(sy0 + ay);
  return _twoSum(sx, sy);
}

function _ddMul(ax: number, ay: number, bx: number, by: number): [number, number] {
  const [px, py0] = _twoProd(ax, bx);
  const py = f32(py0 + f32(f32(ax * by) + f32(ay * bx)));
  return _twoSum(px, py);
}

function _ddMul2(ax: number, ay: number): [number, number] {
  return [f32(2.0 * ax), f32(2.0 * ay)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Test cases
// ─────────────────────────────────────────────────────────────────────────────
// Op codes mirror the switch in TEST_FRAGMENT_SHADER below.
const enum Op {
  TwoSum = 0, TwoProd = 1, Split = 2,
  DdAddF = 3, DdMul   = 4,
  DdAdd  = 5, DdSub   = 6, DdMul2 = 7,
}

interface TestCase {
  name: string;
  why: string;        // why this test matters / what failure tells us
  op: Op;
  a:  [number, number];
  b:  [number, number];
  s:  number;
}

const TESTS: TestCase[] = [
  {
    name: 'sanity: ddAdd(1, 2) → 3',
    why:  'Integer-domain check. If this fails the validator rig itself is broken.',
    op: Op.DdAdd,    a: [1.0, 0], b: [2.0, 0], s: 0,
  },
  {
    name: 'twoSum captures sub-ulp error term',
    why:  'twoSum(1.0, 1.5e-8) must return lo ≈ 1.5e-8. Zero lo means the compiler algebraically simplified the error reconstruction.',
    op: Op.TwoSum,   a: [1.0, 0], b: [1.5e-8, 0], s: 0,
  },
  {
    name: 'twoProd captures rounding error',
    why:  'twoProd(0.1, 0.1) — 0.01 is not exactly representable in float32, so the error term must be nonzero.',
    op: Op.TwoProd,  a: [0.1, 0], b: [0.1, 0], s: 0,
  },
  {
    name: 'split: 12-bit Veltkamp decomposition',
    why:  'split(0.1) must produce a non-trivial low half (~1e-10). Zero lo means the split collapsed to identity.',
    op: Op.Split,    a: [0.1, 0], b: [0,  0], s: 0,
  },
  {
    name: 'ddAddF preserves sub-ulp float',
    why:  'ddAddF((1.0, 0), 1e-8) — this is the exact pattern the shader uses to combine the dd centre with each pixel offset.',
    op: Op.DdAddF,   a: [1.0, 0], b: [0,  0], s: 1e-8,
  },
  {
    name: 'ddMul cross-term propagates a.lo through product',
    why:  'ddMul((1, 1e-8), (1, 0)) — verifies the cross-term a.x*b.y + a.y*b.x reaches the result lo.',
    op: Op.DdMul,    a: [1.0, 1e-8], b: [1.0, 0], s: 0,
  },
  {
    name: 'ddAdd preserves sub-ulp lo across summation',
    why:  'ddAdd((1, 1e-8), (1, 0)) → expected ≈ (2, 1e-8). Critical for iteration step z² + c.',
    op: Op.DdAdd,    a: [1.0, 1e-8], b: [1.0, 0], s: 0,
  },
  {
    name: 'ddSub surfaces lo through catastrophic cancellation',
    why:  'ddSub((1, 1e-8), (1, 0)) → hi cancels, the 1e-8 must reach the result.',
    op: Op.DdSub,    a: [1.0, 1e-8], b: [1.0, 0], s: 0,
  },
  {
    name: 'ddMul2 doubles both hi and lo',
    why:  'ddMul2((0.5, 1e-8)) → (1.0, 2e-8). Cheapest dd op — if this fails everything else will too.',
    op: Op.DdMul2,   a: [0.5, 1e-8], b: [0,  0], s: 0,
  },
];

function expectedFor(tc: TestCase): [number, number] {
  // Inputs go through gl.uniform* which rounds to float32, so the JS reference
  // must do the same to compare apples-to-apples.
  const ax = f32(tc.a[0]), ay = f32(tc.a[1]);
  const bx = f32(tc.b[0]), by = f32(tc.b[1]);
  const s  = f32(tc.s);
  switch (tc.op) {
    case Op.TwoSum:  return _twoSum(ax, bx);
    case Op.TwoProd: return _twoProd(ax, bx);
    case Op.Split:   return _split(ax);
    case Op.DdAddF:  return _ddAddF(ax, ay, s);
    case Op.DdMul:   return _ddMul(ax, ay, bx, by);
    case Op.DdAdd:   return _ddAdd(ax, ay, bx, by);
    case Op.DdSub:   return _ddSub(ax, ay, bx, by);
    case Op.DdMul2:  return _ddMul2(ax, ay);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test shaders
// ─────────────────────────────────────────────────────────────────────────────
const TEST_VERTEX_SHADER = /* glsl */ `#version 300 es
void main() {
  vec2 p[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
  gl_Position = vec4(p[gl_VertexID], 0.0, 1.0);
}`;

const TEST_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

${DD_PRIMITIVES_GLSL}

uniform int   u_op;
uniform vec2  u_a;
uniform vec2  u_b;
uniform float u_s;

out vec4 fragColor;

void main() {
  vec2 r = vec2(0.0);
  if      (u_op == 0) r = twoSum(u_a.x, u_b.x);
  else if (u_op == 1) r = twoProd(u_a.x, u_b.x);
  else if (u_op == 2) r = splitF(u_a.x);
  else if (u_op == 3) r = ddAddF(u_a, u_s);
  else if (u_op == 4) r = ddMul(u_a, u_b);
  else if (u_op == 5) r = ddAdd(u_a, u_b);
  else if (u_op == 6) r = ddSub(u_a, u_b);
  else if (u_op == 7) r = ddMul2(u_a);
  fragColor = vec4(r.x, r.y, 0.0, 1.0);
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Pass / fail policy
// ─────────────────────────────────────────────────────────────────────────────
// The critical thing this validator catches: actual.lo == 0 when expected.lo
// is meaningfully nonzero. Beyond that we allow some slack — float32 is not
// bit-deterministic across GPUs and JS Math.fround uses round-to-nearest-even.
function isPass(actual: [number, number], expected: [number, number]): boolean {
  const hiTol = Math.max(Math.abs(expected[0]) * 1e-6, 1e-30);
  if (Math.abs(actual[0] - expected[0]) > hiTol) return false;

  const ex = Math.abs(expected[1]);
  const ac = Math.abs(actual[1]);

  // Expected lo is effectively zero — actual lo must also be small.
  if (ex < 1e-30) return ac < 1e-20;

  // Expected lo is meaningful — actual must share sign and order of magnitude.
  if (Math.sign(actual[1]) !== Math.sign(expected[1])) return false;
  const ratio = ac / ex;
  return ratio >= 0.5 && ratio <= 2.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
export interface TestResult {
  name: string;
  why: string;
  passed: boolean;
  expected: [number, number];
  actual:   [number, number];
}

export interface ValidationResult {
  allPassed: boolean;
  results:   TestResult[];
  error?:    string;      // populated only if the validator itself failed to set up
}

/**
 * Runs the GPU dd validation suite once. Cheap (a handful of 1×1 draws); call
 * once at app startup.
 */
export function validateDD(): ValidationResult {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const gl = canvas.getContext('webgl2');
  if (!gl) return { allPassed: false, results: [], error: 'WebGL2 not available' };

  // Required to render to / read back from a float32 attachment.
  if (!gl.getExtension('EXT_color_buffer_float')) {
    return { allPassed: false, results: [], error: 'EXT_color_buffer_float not available — cannot read back GPU floats with full precision' };
  }

  const program = compileProgram(gl, TEST_VERTEX_SHADER, TEST_FRAGMENT_SHADER);
  if (typeof program === 'string') {
    return { allPassed: false, results: [], error: 'Test shader compile/link failed: ' + program };
  }

  gl.useProgram(program);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  // 1×1 float32 colour attachment for precise readback.
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    return { allPassed: false, results: [], error: 'Float32 framebuffer is incomplete on this driver' };
  }
  gl.viewport(0, 0, 1, 1);

  const uOp = gl.getUniformLocation(program, 'u_op');
  const uA  = gl.getUniformLocation(program, 'u_a');
  const uB  = gl.getUniformLocation(program, 'u_b');
  const uS  = gl.getUniformLocation(program, 'u_s');

  const buf = new Float32Array(4);
  const results: TestResult[] = [];

  for (const tc of TESTS) {
    gl.uniform1i(uOp, tc.op);
    gl.uniform2f(uA, tc.a[0], tc.a[1]);
    gl.uniform2f(uB, tc.b[0], tc.b[1]);
    gl.uniform1f(uS, tc.s);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, buf);
    const actual: [number, number] = [buf[0], buf[1]];
    const exp = expectedFor(tc);
    results.push({ name: tc.name, why: tc.why, passed: isPass(actual, exp), expected: exp, actual });
  }

  return { allPassed: results.every(r => r.passed), results };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shader compile helper
// ─────────────────────────────────────────────────────────────────────────────
function compileProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram | string {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  if (typeof vs === 'string') return vs;
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (typeof fs === 'string') return fs;
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    return gl.getProgramInfoLog(program) ?? 'link failed';
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: GLenum, src: string): WebGLShader | string {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    return gl.getShaderInfoLog(sh) ?? 'compile failed';
  }
  return sh;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plain-text formatter — paste-friendly multi-line output for the console
// ─────────────────────────────────────────────────────────────────────────────
export function formatResults(result: ValidationResult): string {
  const lines: string[] = [];

  if (result.error) {
    lines.push('=== DD validation: ERROR ===');
    lines.push(result.error);
    return lines.join('\n');
  }

  const total  = result.results.length;
  const passed = result.results.filter(r => r.passed).length;
  const ua     = typeof navigator !== 'undefined' ? navigator.userAgent : '(no navigator)';

  lines.push(`=== DD validation: ${passed}/${total} passed ===`);
  lines.push(`UA: ${ua}`);
  lines.push('');

  for (const r of result.results) {
    const mark = r.passed ? 'PASS' : 'FAIL';
    lines.push(`[${mark}] ${r.name}`);
    lines.push(`       expected: hi=${fmt(r.expected[0])}  lo=${fmt(r.expected[1])}`);
    lines.push(`       actual:   hi=${fmt(r.actual[0])}  lo=${fmt(r.actual[1])}`);
    lines.push(`       why:      ${r.why}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function fmt(n: number): string {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e-3 && abs < 1e6) return n.toPrecision(8);
  return n.toExponential(6);
}
