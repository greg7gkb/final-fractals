/**
 * main.ts — application entry point
 *
 * Wires together:
 *   WebGLRenderer  — GPU-side rendering (shaders, uniforms, draw calls)
 *   Camera         — view state (centre, zoom, rotation)
 *   InputHandler   — converts DOM events → camera mutations
 *   Controls       — HTML panel ↔ uniform state synchronisation
 *
 * The render loop uses requestAnimationFrame, but only re-renders when
 * something has actually changed (dirty flag), saving power on idle.
 */

import { WebGLRenderer, type FractalUniforms } from './renderer/WebGLRenderer.js';
import { defaultCamera } from './navigation/Camera.js';
import { InputHandler } from './navigation/InputHandler.js';
import { Controls } from './ui/Controls.js';

// ── Initial state ──────────────────────────────────────────────────────────

let camera = defaultCamera(0);   // Mandelbrot default view

const uniforms: FractalUniforms = {
  fractalType:   0,       // Mandelbrot
  juliaRe:      -0.7269,  // a pretty Julia set by default
  juliaIm:       0.1889,
  colorScheme:   0,       // Ultra Smooth
  maxIterations: 256,
};

let dirty = true;  // render at least once on startup

// ── Canvas setup ───────────────────────────────────────────────────────────

const canvas = document.getElementById('fractal-canvas') as HTMLCanvasElement;

function resizeCanvas(): void {
  // Use devicePixelRatio for sharp rendering on HiDPI / Retina displays.
  // The CSS size stays at 100vw×100vh; the backing pixel buffer is scaled up.
  const dpr = window.devicePixelRatio ?? 1;
  const w = Math.floor(canvas.clientWidth  * dpr);
  const h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width  = w;
    canvas.height = h;
    renderer.resize(w, h);
    dirty = true;
  }
}

// ── Renderer ───────────────────────────────────────────────────────────────

const renderer = new WebGLRenderer(canvas);
resizeCanvas();

// ── Controls ───────────────────────────────────────────────────────────────

const controls = new Controls(
  uniforms,
  // onFractalChange: reset view to the canonical starting position for each fractal
  (type: number) => {
    camera = defaultCamera(type);
    inputHandler.setCamera(camera);
    dirty = true;
  },
  // onParamChange: just redraw
  () => { dirty = true; },
  // onReset: restore default view for current fractal
  () => {
    camera = defaultCamera(uniforms.fractalType);
    inputHandler.setCamera(camera);
    dirty = true;
  },
);

// ── Input handling ─────────────────────────────────────────────────────────

const inputHandler = new InputHandler(
  canvas,
  camera,
  // onUpdate
  () => { dirty = true; },
  // onFractalSwitch (keyboard 1–5)
  (index: number) => {
    controls.setFractalType(index);
    uniforms.fractalType = index;
    camera = defaultCamera(index);
    inputHandler.setCamera(camera);
    dirty = true;
  },
  // onUIToggle
  (which) => {
    if (which === 'ui') {
      controls.markTutorAction('toggle-ui');
      controls.toggleUI();
    }
    if (which === 'help') controls.toggleHelp(); // handles tutor internally
  },
  // onReset
  () => {
    controls.markTutorAction('reset');
    camera = defaultCamera(uniforms.fractalType);
    inputHandler.setCamera(camera);
    dirty = true;
  },
  // onAction — tutor tracking for drag/scroll/click/rotate/keyboard actions
  (action) => controls.markTutorAction(action),
);

// ── Render loop ────────────────────────────────────────────────────────────

function frame(): void {
  resizeCanvas();

  if (dirty) {
    renderer.render(camera, uniforms);
    controls.updateInfoBar(camera);
    dirty = false;
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// ── Window resize ──────────────────────────────────────────────────────────

window.addEventListener('resize', () => { dirty = true; });
