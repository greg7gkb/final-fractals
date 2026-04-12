/**
 * WebGLRenderer.ts
 *
 * Owns the WebGL2 rendering context and drives the fractal draw loop.
 *
 * ── Lifecycle ────────────────────────────────────────────────────
 *   1. constructor()    — compile shaders, link program, locate uniforms
 *   2. resize()         — called whenever the canvas changes size
 *   3. render(camera)   — called every animation frame; uploads uniforms
 *                         and issues the draw call
 *
 * ── What is a "program"? ─────────────────────────────────────────
 *   A WebGL program is a pair of compiled shaders (vertex + fragment)
 *   linked together on the GPU.  Once linked, we can:
 *     • set "uniform" variables (per-frame parameters like zoom, color…)
 *     • call gl.drawArrays() to run it for every pixel
 *
 * ── Why no vertex buffer? ────────────────────────────────────────
 *   We use the "big triangle" trick: the vertex shader generates
 *   3 hard-coded positions from gl_VertexID, covering the entire screen.
 *   No VBO needed, zero data uploaded to the GPU.
 */

import { VERTEX_SHADER_SRC, FRAGMENT_SHADER_SRC } from './shaders.js';
import type { Camera } from '../navigation/Camera.js';

export interface FractalUniforms {
  fractalType: number;   // 0=Mandelbrot 1=Julia 2=BurningShip 3=Newton 4=Tricorn 5=Custom
  juliaRe: number;
  juliaIm: number;
  colorScheme: number;   // 0–4
  maxIterations: number;
}

export class WebGLRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;

  // Uniform locations — cached once at startup to avoid per-frame lookups
  private uResolution: WebGLUniformLocation;
  // Centre is stored as two vec2 uniforms (hi + lo) to form a "double-double"
  // with ~15 significant digits — this is what enables deep zoom.
  // See shaders.ts for a full explanation of the technique.
  private uCenterHi: WebGLUniformLocation;
  private uCenterLo: WebGLUniformLocation;
  private uZoom: WebGLUniformLocation;
  private uRotation: WebGLUniformLocation;
  private uMaxIterations: WebGLUniformLocation;
  private uFractalType: WebGLUniformLocation;
  private uJuliaC: WebGLUniformLocation;
  private uColorScheme: WebGLUniformLocation;

  // We need a VAO even though we have no vertex data; WebGL2 requires one
  // to be bound before any draw call.
  private vao: WebGLVertexArrayObject;

  constructor(canvas: HTMLCanvasElement) {
    // ── 1. Acquire WebGL2 context ──────────────────────────────────────
    const gl = canvas.getContext('webgl2', {
      antialias: false,    // fractals are pixel-perfect; AA wastes time here
      depth: false,        // we're 2D — no depth buffer needed
      alpha: false,        // opaque canvas
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      throw new Error(
        'WebGL2 is not available in this browser. ' +
        'Please try a modern version of Chrome, Firefox, or Edge.'
      );
    }
    this.gl = gl;

    // ── 2. Compile shaders and link the GPU program ────────────────────
    this.program = this.createProgram(VERTEX_SHADER_SRC, FRAGMENT_SHADER_SRC);

    // ── 3. Cache uniform locations ────────────────────────────────────
    // gl.getUniformLocation returns null if the name doesn't exist or was
    // optimised away by the GLSL compiler.  We cast; callers must match names.
    const loc = (name: string): WebGLUniformLocation => {
      const l = gl.getUniformLocation(this.program, name);
      if (l === null) throw new Error(`Uniform "${name}" not found in shader`);
      return l;
    };
    this.uResolution    = loc('u_resolution');
    this.uCenterHi      = loc('u_center_hi');
    this.uCenterLo      = loc('u_center_lo');
    this.uZoom          = loc('u_zoom');
    this.uRotation      = loc('u_rotation');
    this.uMaxIterations = loc('u_maxIterations');
    this.uFractalType   = loc('u_fractalType');
    this.uJuliaC        = loc('u_juliaC');
    this.uColorScheme   = loc('u_colorScheme');

    // ── 4. Empty VAO ──────────────────────────────────────────────────
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create VAO');
    this.vao = vao;
  }

  /**
   * Resize the WebGL viewport to match the canvas's pixel dimensions.
   * Call this whenever the canvas is resized (window resize, devicePixelRatio change).
   */
  resize(width: number, height: number): void {
    this.gl.viewport(0, 0, width, height);
  }

  /**
   * Render one frame.
   *
   * Upload the current camera state + fractal parameters as uniforms,
   * then call drawArrays to trigger the GPU pipeline:
   *   vertex shader × 3 vertices → rasterise → fragment shader × (width×height) pixels
   */
  render(camera: Camera, uniforms: FractalUniforms): void {
    const gl = this.gl;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    // Upload uniforms — each gl.uniform* call copies a value to the GPU
    gl.uniform2f(this.uResolution, gl.canvas.width, gl.canvas.height);

    // Split the float64 centre coordinates into (hi, lo) float32 pairs.
    // Math.fround() gives the nearest float32; the residual is the lo term.
    // Together hi+lo recovers the full float64 precision in the shader.
    const reHi = Math.fround(camera.centerRe);
    const reLo = camera.centerRe - reHi;
    const imHi = Math.fround(camera.centerIm);
    const imLo = camera.centerIm - imHi;
    gl.uniform2f(this.uCenterHi, reHi, imHi);
    gl.uniform2f(this.uCenterLo, reLo, imLo);
    gl.uniform1f(this.uZoom,          camera.zoom);
    gl.uniform1f(this.uRotation,      camera.rotation);
    gl.uniform1i(this.uMaxIterations, uniforms.maxIterations);
    gl.uniform1i(this.uFractalType,   uniforms.fractalType);
    gl.uniform2f(this.uJuliaC,        uniforms.juliaRe, uniforms.juliaIm);
    gl.uniform1i(this.uColorScheme,   uniforms.colorScheme);

    // Draw 3 vertices → one big triangle → fragment shader runs per pixel.
    // gl.TRIANGLES means every group of 3 vertices forms one triangle.
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(null);
  }

  // ── Private: shader / program compilation ───────────────────────────────

  /**
   * Compile a single shader stage (vertex or fragment).
   * Throws a human-readable error if the GLSL contains compile errors.
   */
  private compileShader(source: string, type: GLenum): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Failed to create shader object');

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? '(no log)';
      const typeName = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
      gl.deleteShader(shader);
      throw new Error(`${typeName} shader compile error:\n${log}`);
    }
    return shader;
  }

  /**
   * Link a vertex + fragment shader into a complete GPU program.
   * After this the program can be bound with gl.useProgram().
   */
  private createProgram(vertSrc: string, fragSrc: string): WebGLProgram {
    const gl = this.gl;
    const vert = this.compileShader(vertSrc, gl.VERTEX_SHADER);
    const frag = this.compileShader(fragSrc, gl.FRAGMENT_SHADER);

    const program = gl.createProgram();
    if (!program) throw new Error('Failed to create program object');

    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);

    // Shaders are now baked into the program; detach to free driver resources
    gl.detachShader(program, vert);
    gl.detachShader(program, frag);
    gl.deleteShader(vert);
    gl.deleteShader(frag);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? '(no log)';
      gl.deleteProgram(program);
      throw new Error(`Shader program link error:\n${log}`);
    }
    return program;
  }
}
