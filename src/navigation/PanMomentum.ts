/**
 * PanMomentum.ts — inertial coasting after a mouse-pan release
 *
 * Tracks a rolling window of recent pan deltas in a fixed-size ring buffer,
 * then on release computes a release velocity and drives an exponentially-
 * decaying RAF loop that keeps the camera moving until it coasts to a stop.
 *
 * All velocities are in complex-plane units per millisecond, which keeps
 * the effect correctly proportional to the current zoom level.
 *
 * Usage:
 *   momentum.record(dRe, dIm)          — call on every pan mousemove
 *   momentum.launch(camera, onUpdate)  — call on mouseup to start the coast
 *   momentum.cancel()                  — call on mousedown / reset / destroy
 */

import type { Camera } from './Camera.js';
import { panBy } from './Camera.js';

export class PanMomentum {
  // ── Tuning ──────────────────────────────────────────────────────────────────
  // FRICTION: per-frame multiplier applied every nominal 16.67 ms (60 fps).
  // Decay is frame-rate-independent: actual_decay = FRICTION ^ (dt / 16.667).
  //   0.80 → velocity halves in ~3 frames (~50 ms); glide fades in ~0.3 s
  //   0.92 → velocity halves in ~11 frames (~185 ms); glide fades in ~1 s
  //   0.98 → very long glide, several seconds
  private readonly FRICTION   = 0.80;
  private readonly BOOST      = 1.0;    // release-velocity multiplier (1 = natural)
  private readonly MIN_SPEED  = 5e-10;  // complex units/ms — stop threshold
  private readonly VEL_WINDOW = 80;     // ms of history used for velocity estimate

  // ── Ring buffer ─────────────────────────────────────────────────────────────
  // Fixed-size circular buffer: O(1) writes during the mousemove hot path,
  // no Array.shift() / re-indexing.
  private readonly BUF_SIZE = 32;
  private velBuf      = new Array<{ t: number; dRe: number; dIm: number }>(32);
  private velBufHead  = 0;   // next slot to write
  private velBufCount = 0;   // number of valid entries (0 … BUF_SIZE)

  // ── Coast state ─────────────────────────────────────────────────────────────
  private velRe = 0;
  private velIm = 0;
  private rafId: number | null = null;

  /**
   * Record a pan delta (in complex-plane units) into the ring buffer.
   * Call this on every mousemove event during a pan.
   */
  record(dRe: number, dIm: number): void {
    this.velBuf[this.velBufHead] = { t: performance.now(), dRe, dIm };
    this.velBufHead = (this.velBufHead + 1) % this.BUF_SIZE;
    if (this.velBufCount < this.BUF_SIZE) this.velBufCount++;
  }

  /**
   * Compute release velocity from the ring buffer and start the coast RAF loop.
   * Call this on mouseup (pan gesture only — not rotation).
   * No-ops silently if there isn't enough data for a reliable velocity estimate.
   */
  launch(camera: Camera, onUpdate: () => void): void {
    if (this.velBufCount < 2) return;

    // Walk the buffer newest-first, accumulating samples within VEL_WINDOW ms.
    const size    = this.BUF_SIZE;
    const newestI = (this.velBufHead - 1 + size) % size;
    const newest  = this.velBuf[newestI];
    const cutoff  = newest.t - this.VEL_WINDOW;

    let sumRe = 0, sumIm = 0, firstT = newest.t, n = 0;
    for (let k = 0; k < this.velBufCount; k++) {
      const s = this.velBuf[(this.velBufHead - 1 - k + size * 2) % size];
      if (s.t < cutoff) break;
      sumRe += s.dRe;
      sumIm += s.dIm;
      firstT = s.t;
      n++;
    }

    const dt = newest.t - firstT;
    if (n < 2 || dt < 4) return;  // tap or stationary release — no coast

    // cancel() zeroes velRe/velIm, so call it BEFORE setting new velocity.
    this.cancel();

    this.velRe = (sumRe / dt) * this.BOOST;
    this.velIm = (sumIm / dt) * this.BOOST;
    if (Math.abs(this.velRe) + Math.abs(this.velIm) < this.MIN_SPEED) return;

    let lastTime = performance.now();
    const step = (now: number): void => {
      const frameDt = Math.min(now - lastTime, 64);  // cap: prevents jump after tab-hide
      lastTime = now;

      panBy(camera, this.velRe * frameDt, this.velIm * frameDt);

      const decay = Math.pow(this.FRICTION, frameDt / 16.667);
      this.velRe *= decay;
      this.velIm *= decay;

      onUpdate();

      if (Math.abs(this.velRe) + Math.abs(this.velIm) > this.MIN_SPEED) {
        this.rafId = requestAnimationFrame(step);
      } else {
        this.rafId = null;
      }
    };

    this.rafId = requestAnimationFrame(step);
  }

  /**
   * Stop any in-flight coast and reset all state.
   * Call this on mousedown, camera reset, or destroy.
   */
  cancel(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.velRe       = 0;
    this.velIm       = 0;
    this.velBufHead  = 0;
    this.velBufCount = 0;
  }
}
