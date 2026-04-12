/**
 * GridOverlay.ts — draws the complex coordinate plane as a 2D canvas overlay
 *
 * Rendered on a separate <canvas> element that sits on top of the WebGL canvas.
 * Uses the Canvas2D API for lines and text — much simpler than doing it in GLSL.
 *
 * Coordinate transform: the inverse of pixelToComplex() in Camera.ts.
 * Given a complex number (re, im), we find its DOM pixel (px, py) by:
 *   1. Subtract camera centre
 *   2. Apply inverse rotation (transpose of CCW matrix = CW matrix)
 *   3. Scale by h / zoom
 *   4. Offset by canvas centre, flip Y (DOM y is top-down)
 */

import { Camera } from '../navigation/Camera.js';

// ── Coordinate transform ─────────────────────────────────────────────────────

function complexToPixel(
  re: number,
  im: number,
  camera: Camera,
  w: number,
  h: number,
): [number, number] {
  const dRe = re - camera.centerRe;
  const dIm = im - camera.centerIm;

  // Inverse rotation: CW by camera.rotation (transpose of the CCW shader matrix)
  const cos  = Math.cos(camera.rotation);
  const sin  = Math.sin(camera.rotation);
  const rotX =  dRe * cos + dIm * sin;
  const rotY = -dRe * sin + dIm * cos;

  // Scale and place — note Y is flipped (complex Im+ = up = smaller DOM y)
  const scale = h / camera.zoom;
  return [rotX * scale + w / 2, h / 2 - rotY * scale];
}

// ── Nice grid step ────────────────────────────────────────────────────────────
// Picks a "round" step value (1, 2, or 5 × 10^n) so labels are clean numbers.

function niceStep(range: number, targetLines: number): number {
  const rough = range / targetLines;
  const mag   = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm  = rough / mag;
  const nice  = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return nice * mag;
}

// Format a coordinate value to an appropriate number of decimal places.
function fmt(v: number, step: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return v.toFixed(decimals);
}

// ── Typography ───────────────────────────────────────────────────────────────
// Sizes are in CSS px — multiplied by devicePixelRatio at draw time because
// the canvas backing store is scaled up for HiDPI/Retina displays.
const FONT_FAMILY     = 'monospace';
const FONT_SIZE_COORD = 11;   // grid coordinate labels  (CSS px)
const FONT_SIZE_AXIS  = 13;   // Re / Im axis labels     (CSS px)

// ── GridOverlay class ─────────────────────────────────────────────────────────

export class GridOverlay {
  private canvas: HTMLCanvasElement;
  private ctx:    CanvasRenderingContext2D;
  private visible = false;

  constructor() {
    this.canvas = document.getElementById('grid-canvas') as HTMLCanvasElement;
    this.ctx    = this.canvas.getContext('2d')!;
  }

  get isVisible(): boolean { return this.visible; }

  toggle(): void {
    this.visible = !this.visible;
    this.canvas.classList.toggle('hidden', !this.visible);
  }

  /** Call whenever the canvas is resized. */
  resize(width: number, height: number): void {
    this.canvas.width  = width;
    this.canvas.height = height;
  }

  /** Redraw the overlay for the current camera. Clears when hidden. */
  draw(camera: Camera): void {
    const w   = this.canvas.width;
    const h   = this.canvas.height;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    if (!this.visible) return;

    const visH   = camera.zoom;
    const visW   = camera.zoom * (w / h);
    // Extra margin so lines fill the screen even when rotated
    const margin = Math.max(visW, visH) * 1.5;

    const reMin = camera.centerRe - margin;
    const reMax = camera.centerRe + margin;
    const imMin = camera.centerIm - margin;
    const imMax = camera.centerIm + margin;

    const step = niceStep(visH, 8);
    const dpr  = window.devicePixelRatio ?? 1;

    ctx.font      = `${FONT_SIZE_COORD * dpr}px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';

    // ── Vertical grid lines (constant Re) ──────────────────────────────────
    const reStart = Math.ceil(reMin / step) * step;
    for (let re = reStart; re <= reMax; re += step) {
      const isAxis = Math.abs(re) < step * 1e-6;
      const [x1, y1] = complexToPixel(re, imMin, camera, w, h);
      const [x2, y2] = complexToPixel(re, imMax, camera, w, h);

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = isAxis ? 'rgba(255,255,255,0.80)' : 'rgba(255,255,255,0.18)';
      ctx.lineWidth   = isAxis ? 1.5 : 1;
      ctx.stroke();

      // Label at the point where this Re line crosses the Im=0 axis
      if (!isAxis) {
        const [lx, ly] = complexToPixel(re, 0, camera, w, h);
        if (lx > 20 && lx < w - 20 && ly > 20 && ly < h - 20) {
          ctx.fillStyle    = 'rgba(255,255,255,0.55)';
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(fmt(re, step), lx, ly + 4);
        }
      }
    }

    // ── Horizontal grid lines (constant Im) ────────────────────────────────
    const imStart = Math.ceil(imMin / step) * step;
    for (let im = imStart; im <= imMax; im += step) {
      const isAxis = Math.abs(im) < step * 1e-6;
      const [x1, y1] = complexToPixel(reMin, im, camera, w, h);
      const [x2, y2] = complexToPixel(reMax, im, camera, w, h);

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = isAxis ? 'rgba(255,255,255,0.80)' : 'rgba(255,255,255,0.18)';
      ctx.lineWidth   = isAxis ? 1.5 : 1;
      ctx.stroke();

      // Label at the point where this Im line crosses the Re=0 axis
      if (!isAxis) {
        const [lx, ly] = complexToPixel(0, im, camera, w, h);
        if (lx > 20 && lx < w - 20 && ly > 20 && ly < h - 20) {
          ctx.fillStyle    = 'rgba(255,255,255,0.55)';
          ctx.textAlign    = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText(fmt(im, step) + 'i', lx - 4, ly);
        }
      }
    }

    // ── Axis labels (Re / Im) ───────────────────────────────────────────────
    ctx.font         = `${FONT_SIZE_AXIS * dpr}px ${FONT_FAMILY}`;
    ctx.fillStyle    = 'rgba(255,255,255,0.85)';
    ctx.textBaseline = 'middle';

    // "Re" label: on the real axis, near the right edge of the screen
    const [reLabX, reLabY] = complexToPixel(camera.centerRe + visW * 0.42, 0, camera, w, h);
    if (reLabX > 0 && reLabX < w && reLabY > 0 && reLabY < h) {
      ctx.textAlign = 'right';
      ctx.fillText('Re', reLabX, reLabY - 10);
    }

    // "Im" label: on the imaginary axis, near the top edge of the screen
    const [imLabX, imLabY] = complexToPixel(0, camera.centerIm + visH * 0.42, camera, w, h);
    if (imLabX > 0 && imLabX < w && imLabY > 0 && imLabY < h) {
      ctx.textAlign = 'left';
      ctx.fillText('Im', imLabX + 6, imLabY);
    }

    // Origin dot
    const [ox, oy] = complexToPixel(0, 0, camera, w, h);
    if (ox > 0 && ox < w && oy > 0 && oy < h) {
      ctx.beginPath();
      ctx.arc(ox, oy, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
    }
  }
}
