/**
 * InputHandler.ts — mouse, trackpad, touch, and keyboard navigation
 *
 * Translates raw DOM events into camera mutations, then calls
 * onUpdate() so the caller can schedule a re-render.
 *
 * Navigation model (Google Maps-like):
 *   • Drag               — pan (with momentum on release)
 *   • Scroll wheel       — zoom centred on cursor
 *   • Double-click       — zoom in ×2 centred on click point
 *   • Ctrl + drag        — rotate
 *   • Arrow keys         — pan (10% of view per press)
 *   • + / −              — zoom in / out
 *   • R                  — reset view to fractal default
 *   • 1–5                — switch fractal (convenience)
 *   • U                  — toggle UI panels
 *   • H                  — toggle help overlay
 *   • Pinch (touchpad / mobile) — zoom
 */

import type { Camera } from './Camera.js';
import { zoomAt, panBy, pixelToComplex, pixelDeltaToComplex } from './Camera.js';
import { PanMomentum } from './PanMomentum.js';

type UpdateCallback = () => void;
type FractalSwitchCallback = (index: number) => void;
type UIToggleCallback = (which: 'ui' | 'help' | 'info' | 'grid') => void;
type ResetCallback = () => void;
type CaptureCallback = () => void;
// Fired whenever the user performs a trackable action (tutor system).
// IDs match the data-action attributes in the help overlay HTML.
type ActionCallback = (action: string) => void;

export class InputHandler {
  private canvas: HTMLCanvasElement;
  private camera: Camera;
  private onUpdate: UpdateCallback;
  private onFractalSwitch: FractalSwitchCallback;
  private onUIToggle: UIToggleCallback;
  private onReset: ResetCallback;
  private onCapture: CaptureCallback;
  private onAction: ActionCallback;

  // Drag state
  private isDragging = false;
  private isRotating = false;       // Ctrl held during drag
  private lastMouseX = 0;
  private lastMouseY = 0;

  // Rotation pivot — the complex-plane point under the cursor when Ctrl+drag begins.
  // We keep this point fixed on screen as rotation changes by adjusting the centre.
  private rotatePivotRe = 0;
  private rotatePivotIm = 0;

  // Touch / pinch state
  private lastPinchDist = 0;

  // Pan momentum — coasts the view to a stop after mouse release
  private readonly momentum = new PanMomentum();

  constructor(
    canvas: HTMLCanvasElement,
    camera: Camera,
    onUpdate: UpdateCallback,
    onFractalSwitch: FractalSwitchCallback,
    onUIToggle: UIToggleCallback,
    onReset: ResetCallback,
    onCapture: CaptureCallback,
    onAction: ActionCallback,
  ) {
    this.canvas = canvas;
    this.camera = camera;
    this.onUpdate = onUpdate;
    this.onFractalSwitch = onFractalSwitch;
    this.onUIToggle = onUIToggle;
    this.onReset = onReset;
    this.onCapture = onCapture;
    this.onAction = onAction;

    this.attachListeners();
  }

  /** Replace the camera reference (used when fractal type changes and resets view) */
  setCamera(camera: Camera): void {
    this.momentum.cancel();
    this.camera = camera;
  }

  private attachListeners(): void {
    const c = this.canvas;

    // ── Mouse ──────────────────────────────────────────────────────────
    c.addEventListener('mousedown',   this.onMouseDown);
    c.addEventListener('mousemove',   this.onMouseMove);
    c.addEventListener('mouseup',     this.onMouseUp);
    c.addEventListener('mouseleave',  this.onMouseUp);       // cancel drag on leave
    c.addEventListener('wheel',       this.onWheel, { passive: false });
    c.addEventListener('dblclick',    this.onDoubleClick);
    c.addEventListener('contextmenu', (e) => e.preventDefault()); // suppress right-click menu

    // ── Touch ──────────────────────────────────────────────────────────
    c.addEventListener('touchstart',  this.onTouchStart, { passive: false });
    c.addEventListener('touchmove',   this.onTouchMove,  { passive: false });
    c.addEventListener('touchend',    this.onTouchEnd);

    // ── Keyboard ───────────────────────────────────────────────────────
    window.addEventListener('keydown', this.onKeyDown);
  }

  destroy(): void {
    this.momentum.cancel();
    const c = this.canvas;
    c.removeEventListener('mousedown',  this.onMouseDown);
    c.removeEventListener('mousemove',  this.onMouseMove);
    c.removeEventListener('mouseup',    this.onMouseUp);
    c.removeEventListener('mouseleave', this.onMouseUp);
    c.removeEventListener('wheel',      this.onWheel);
    c.removeEventListener('dblclick',   this.onDoubleClick);
    c.removeEventListener('touchstart', this.onTouchStart);
    c.removeEventListener('touchmove',  this.onTouchMove);
    c.removeEventListener('touchend',   this.onTouchEnd);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  // ── Mouse handlers ────────────────────────────────────────────────────

  private onMouseDown = (e: MouseEvent): void => {
    // Return keyboard focus to the canvas whenever the user clicks on it,
    // regardless of which control currently holds focus.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

    // Stop any in-flight coast so the grab feels crisp and immediate.
    this.momentum.cancel();

    this.isDragging = true;
    this.isRotating = e.ctrlKey || e.metaKey;
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;

    if (this.isRotating) {
      // Record the complex-plane point under the cursor as the rotation pivot.
      // We'll keep this point fixed on screen as rotation changes.
      const rect = this.canvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (this.canvas.width  / rect.width);
      const py = (e.clientY - rect.top)  * (this.canvas.height / rect.height);
      [this.rotatePivotRe, this.rotatePivotIm] = pixelToComplex(this.camera, this.canvas, px, py);
    }

    this.canvas.classList.add('dragging');
    e.preventDefault();
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.isDragging) return;

    const dx = e.clientX - this.lastMouseX;
    const dy = e.clientY - this.lastMouseY;
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;

    if (this.isRotating) {
      // Horizontal drag → rotate around the pivot point recorded at drag-start.
      // One full canvas width ≈ 2π.
      const dθ = -(dx / this.canvas.width) * Math.PI * 2;
      this.camera.rotation += dθ;

      // Adjust the view centre so the pivot stays at the same screen position.
      // Rotating the centre around the pivot by dθ achieves this:
      //   centre_new = pivot + rotate(centre_old − pivot, dθ)
      const offRe = this.camera.centerRe - this.rotatePivotRe;
      const offIm = this.camera.centerIm - this.rotatePivotIm;
      const cos = Math.cos(dθ);
      const sin = Math.sin(dθ);
      this.camera.centerRe = this.rotatePivotRe + offRe * cos - offIm * sin;
      this.camera.centerIm = this.rotatePivotIm + offRe * sin + offIm * cos;
      this.onAction('rotate');
    } else {
      // Convert pixel delta → complex-plane displacement and pan
      const [dRe, dIm] = pixelDeltaToComplex(this.camera, this.canvas, -dx, dy);
      panBy(this.camera, dRe, dIm);

      this.momentum.record(dRe, dIm);

      this.onAction('pan-drag');
    }
    this.onUpdate();
  };

  private onMouseUp = (): void => {
    if (this.isDragging && !this.isRotating) {
      this.momentum.launch(this.camera, this.onUpdate);
    }
    this.isDragging = false;
    this.isRotating = false;
    this.canvas.classList.remove('dragging');
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();

    // Normalise wheel delta — browsers report in different units
    let delta = e.deltaY;
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
    if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= 400;

    // Each 100px of scroll ≈ 20% zoom change
    const factor = Math.pow(1.001, delta);

    // Zoom towards the point under the cursor
    const rect = this.canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (this.canvas.width  / rect.width);
    const py = (e.clientY - rect.top)  * (this.canvas.height / rect.height);
    const [tRe, tIm] = pixelToComplex(this.camera, this.canvas, px, py);
    zoomAt(this.camera, factor, tRe, tIm);
    this.onAction('zoom-scroll');
    this.onUpdate();
  };

  private onDoubleClick = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (this.canvas.width  / rect.width);
    const py = (e.clientY - rect.top)  * (this.canvas.height / rect.height);
    const [tRe, tIm] = pixelToComplex(this.camera, this.canvas, px, py);
    zoomAt(this.camera, 0.5, tRe, tIm);   // ×2 zoom in
    this.onAction('zoom-click');
    this.onUpdate();
  };

  // ── Touch handlers (single-finger pan + two-finger pinch-zoom) ─────────

  private onTouchStart = (e: TouchEvent): void => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    e.preventDefault();
    if (e.touches.length === 1) {
      this.isDragging = true;
      this.lastMouseX = e.touches[0].clientX;
      this.lastMouseY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      this.isDragging = false;
      this.lastPinchDist = this.touchDist(e.touches);
    }
  };

  private onTouchMove = (e: TouchEvent): void => {
    e.preventDefault();
    if (e.touches.length === 1 && this.isDragging) {
      const dx = e.touches[0].clientX - this.lastMouseX;
      const dy = e.touches[0].clientY - this.lastMouseY;
      this.lastMouseX = e.touches[0].clientX;
      this.lastMouseY = e.touches[0].clientY;
      const [dRe, dIm] = pixelDeltaToComplex(this.camera, this.canvas, -dx, dy);
      panBy(this.camera, dRe, dIm);
      this.onUpdate();
    } else if (e.touches.length === 2) {
      const dist = this.touchDist(e.touches);
      if (this.lastPinchDist > 0) {
        const factor = this.lastPinchDist / dist;
        // Zoom towards midpoint of the two fingers
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const rect = this.canvas.getBoundingClientRect();
        const px = (mx - rect.left) * (this.canvas.width  / rect.width);
        const py = (my - rect.top)  * (this.canvas.height / rect.height);
        const [tRe, tIm] = pixelToComplex(this.camera, this.canvas, px, py);
        zoomAt(this.camera, factor, tRe, tIm);
        this.onUpdate();
      }
      this.lastPinchDist = dist;
    }
  };

  private onTouchEnd = (): void => {
    this.isDragging = false;
    this.lastPinchDist = 0;
  };

  private touchDist(touches: TouchList): number {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ── Keyboard handler ──────────────────────────────────────────────────

  private onKeyDown = (e: KeyboardEvent): void => {
    // Don't capture keys when user is typing in an input
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

    const panStep = this.camera.zoom * 0.12;  // 12% of view height per keypress

    // Screen-space basis vectors in complex-plane coordinates.
    // These match the shader's rotation transform so arrow keys always
    // move in the direction they appear on screen, regardless of rotation.
    //   screen-right = (cos θ,  sin θ)
    //   screen-up    = (-sin θ, cos θ)
    const cos = Math.cos(this.camera.rotation);
    const sin = Math.sin(this.camera.rotation);

    switch (e.key) {
      // ── Pan ──────────────────────────────────────────────────────────
      case 'ArrowLeft':
        e.preventDefault();
        panBy(this.camera, -cos * panStep, -sin * panStep);
        this.onAction('pan-keys');
        this.onUpdate();
        break;
      case 'ArrowRight':
        e.preventDefault();
        panBy(this.camera,  cos * panStep,  sin * panStep);
        this.onAction('pan-keys');
        this.onUpdate();
        break;
      case 'ArrowUp':
        e.preventDefault();
        panBy(this.camera, -sin * panStep,  cos * panStep);
        this.onAction('pan-keys');
        this.onUpdate();
        break;
      case 'ArrowDown':
        e.preventDefault();
        panBy(this.camera,  sin * panStep, -cos * panStep);
        this.onAction('pan-keys');
        this.onUpdate();
        break;

      // ── Zoom ─────────────────────────────────────────────────────────
      case '+':
      case '=':
        zoomAt(this.camera, 0.8, this.camera.centerRe, this.camera.centerIm);
        this.onAction('zoom-keys');
        this.onUpdate();
        break;
      case '-':
      case '_':
        zoomAt(this.camera, 1.25, this.camera.centerRe, this.camera.centerIm);
        this.onAction('zoom-keys');
        this.onUpdate();
        break;

      // ── Rotate ───────────────────────────────────────────────────────
      case ',':
        this.camera.rotation -= 0.05;
        this.onUpdate();
        break;
      case '.':
        this.camera.rotation += 0.05;
        this.onUpdate();
        break;

      // ── Reset ─────────────────────────────────────────────────────────
      case 'r':
      case 'R':
        this.onReset();
        break;

      // ── Save image ────────────────────────────────────────────────────
      case 's':
      case 'S':
        this.onCapture();
        break;

      // ── Toggle UI ─────────────────────────────────────────────────────
      case 'u':
      case 'U':
        this.onUIToggle('ui');
        break;
      case 'i':
      case 'I':
        this.onUIToggle('info');
        break;
      case 'g':
      case 'G':
        this.onUIToggle('grid');
        break;
      case 'h':
      case 'H':
        this.onUIToggle('help');
        break;

      // ── Fractal hotkeys ───────────────────────────────────────────────
      case '1': this.onFractalSwitch(0); break;
      case '2': this.onFractalSwitch(1); break;
      case '3': this.onFractalSwitch(2); break;
      case '4': this.onFractalSwitch(3); break;
      case '5': this.onFractalSwitch(4); break;
    }
  };
}
