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
import { GridOverlay } from './ui/GridOverlay.js';

// ── Initial state ──────────────────────────────────────────────────────────

let camera = defaultCamera(0);   // Mandelbrot default view

const uniforms: FractalUniforms = {
  fractalType:   0,       // Mandelbrot
  juliaRe:      -0.7269,  // a pretty Julia set by default
  juliaIm:       0.1889,
  colorScheme:   8,       // Bernstein (default)
  maxIterations: 256,
};

let dirty = true;  // render at least once on startup
let captureRequested = false;

// ── Image capture ──────────────────────────────────────────────────────────
// We request the capture during the next render frame so the WebGL drawing
// buffer is guaranteed to be populated (avoids the blank-canvas problem that
// occurs if toBlob() is called outside the render cycle).

const FRACTAL_NAMES_FILE = ['mandelbrot', 'julia', 'burning-ship', 'newton', 'tricorn', 'custom'];

function requestCapture(): void {
  captureRequested = true;
  dirty = true;  // ensure a render frame fires even if nothing has changed
}

function executeCapture(): void {
  const name  = FRACTAL_NAMES_FILE[uniforms.fractalType] ?? 'fractal';
  const zoom  = (3 / camera.zoom).toFixed(1);
  const re    = camera.centerRe.toFixed(6);
  const im    = camera.centerIm.toFixed(6);
  const filename = `fractal_${name}_zoom${zoom}x_${re}_${im}.png`;

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

// ── FPS tracking ───────────────────────────────────────────────────────────
// We only render when dirty, so we track time between actual render calls
// rather than rAF ticks. A short rolling window gives a responsive reading.
const FPS_WINDOW = 30;              // smooth over up to 30 render timestamps
const fpsTimestamps: number[] = []; // circular buffer of recent render times
const FPS_IDLE_MS  = 2000;         // show "—" after 2 s with no new renders

function recordRender(): void {
  const now = performance.now();
  fpsTimestamps.push(now);
  if (fpsTimestamps.length > FPS_WINDOW) fpsTimestamps.shift();
}

function currentFps(): number | null {
  if (fpsTimestamps.length < 2) return null;
  const newest = fpsTimestamps[fpsTimestamps.length - 1];
  if (performance.now() - newest > FPS_IDLE_MS) return null; // gone idle
  const span = newest - fpsTimestamps[0];
  return Math.round((fpsTimestamps.length - 1) / (span / 1000));
}

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
    gridOverlay.resize(w, h);  // keep overlay canvas in sync
    dirty = true;
  }
}

// ── Renderer ───────────────────────────────────────────────────────────────

const renderer = new WebGLRenderer(canvas);

// ── Grid overlay ───────────────────────────────────────────────────────────

const gridOverlay = new GridOverlay();

// Resize both canvases together — order matters, gridOverlay must exist first
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
  // onCapture: save current frame as PNG
  () => requestCapture(),
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
    if (which === 'info') {
      controls.markTutorAction('toggle-info');
      controls.toggleInfo();
    }
    if (which === 'grid') { gridOverlay.toggle(); dirty = true; }
    if (which === 'help') controls.toggleHelp(); // handles tutor internally
  },
  // onReset
  () => {
    controls.markTutorAction('reset');
    camera = defaultCamera(uniforms.fractalType);
    inputHandler.setCamera(camera);
    dirty = true;
  },
  // onCapture
  () => requestCapture(),
  // onAction — tutor tracking for drag/scroll/click/rotate/keyboard actions
  (action) => controls.markTutorAction(action),
);

// ── Render loop ────────────────────────────────────────────────────────────

function frame(): void {
  resizeCanvas();

  if (dirty) {
    renderer.render(camera, uniforms);
    if (captureRequested) {
      executeCapture();   // called right after render so the drawing buffer is populated
      captureRequested = false;
    }
    gridOverlay.draw(camera);
    recordRender();
    dirty = false;
  }

  // updateInfoBar runs every rAF tick (not just when dirty) so the FPS counter
  // can tick down to 0 after the 2-second idle window, even when nothing is rendering.
  controls.updateInfoBar(camera, currentFps(), canvas.width, canvas.height);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// ── Window resize ──────────────────────────────────────────────────────────

window.addEventListener('resize', () => { dirty = true; });
