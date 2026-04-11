/**
 * Controls.ts — wires the HTML control panel to the app state
 *
 * Reads and writes the DOM elements defined in index.html, firing
 * callbacks whenever the user changes a setting.
 */

import type { FractalUniforms } from '../renderer/WebGLRenderer.js';
import type { Camera } from '../navigation/Camera.js';

const FRACTAL_NAMES = ['Mandelbrot', 'Julia Set', 'Burning Ship', 'Newton', 'Tricorn'];

// All action IDs that have a tutor dot in the help overlay (order matters for UX, not logic)
const TUTOR_ACTIONS = [
  'pan-drag', 'zoom-scroll', 'zoom-click', 'rotate',
  'pan-keys', 'zoom-keys', 'reset', 'toggle-ui', 'toggle-info', 'toggle-help',
];

export class Controls {
  // ── Tutor state ──────────────────────────────────────────────────────────
  // Tracks which help-overlay actions the user has performed.
  // Once all are done the overlay fades away automatically.
  private tutorCompleted = new Set<string>();
  private tutorFinished = false;

  // DOM references
  private selectFractal: HTMLSelectElement;
  private juliaPanelEl: HTMLElement;
  private juliaReInput: HTMLInputElement;
  private juliaImInput: HTMLInputElement;
  private selectColor: HTMLSelectElement;
  private rangeIterations: HTMLInputElement;
  private labelIterations: HTMLElement;
  private btnReset: HTMLButtonElement;
  private infoBar: HTMLElement;
  private infoCoords: HTMLElement;
  private infoZoom: HTMLElement;
  private infoRotation: HTMLElement;
  private infoFps: HTMLElement;
  private infoFractal: HTMLElement;
  private controlsPanel: HTMLElement;
  private helpOverlay: HTMLElement;

  constructor(
    private uniforms: FractalUniforms,
    private onFractalChange: (type: number) => void,
    private onParamChange: () => void,
    private onReset: () => void,
  ) {
    this.selectFractal    = document.getElementById('select-fractal')    as HTMLSelectElement;
    this.juliaPanelEl     = document.getElementById('julia-params')      as HTMLElement;
    this.juliaReInput     = document.getElementById('julia-re')          as HTMLInputElement;
    this.juliaImInput     = document.getElementById('julia-im')          as HTMLInputElement;
    this.selectColor      = document.getElementById('select-color')      as HTMLSelectElement;
    this.rangeIterations  = document.getElementById('range-iterations')  as HTMLInputElement;
    this.labelIterations  = document.getElementById('label-iterations')  as HTMLElement;
    this.btnReset         = document.getElementById('btn-reset')         as HTMLButtonElement;
    this.infoBar          = document.getElementById('info-bar')          as HTMLElement;
    this.infoCoords       = document.getElementById('info-coords')       as HTMLElement;
    this.infoZoom         = document.getElementById('info-zoom')         as HTMLElement;
    this.infoRotation     = document.getElementById('info-rotation')     as HTMLElement;
    this.infoFps          = document.getElementById('info-fps')          as HTMLElement;
    this.infoFractal      = document.getElementById('info-fractal')      as HTMLElement;
    this.controlsPanel    = document.getElementById('controls')          as HTMLElement;
    this.helpOverlay      = document.getElementById('help-overlay')      as HTMLElement;

    this.attachListeners();
    this.syncFromUniforms();
  }

  /** Called by InputHandler when a keyboard shortcut switches the fractal */
  setFractalType(type: number): void {
    this.uniforms.fractalType = type;
    this.selectFractal.value = String(type);
    this.updateJuliaVisibility();
    this.updateColorSchemeAvailability();
    this.syncInfoFractal();
  }

  /** Update the bottom-left info bar from current camera + perf state */
  updateInfoBar(camera: Camera, fps: number | null): void {
    this.infoCoords.textContent =
      `Re: ${camera.centerRe.toFixed(6)}   Im: ${camera.centerIm.toFixed(6)}`;

    // Zoom expressed as a multiplier relative to initial zoom=3
    const zoomX = (3 / camera.zoom).toFixed(2);
    this.infoZoom.textContent = `Zoom: ${zoomX}×`;

    // Rotation in degrees, normalised to [0°, 360°)
    const deg = ((camera.rotation * 180 / Math.PI) % 360 + 360) % 360;
    this.infoRotation.textContent = `Rotation: ${deg.toFixed(1)}°`;

    // FPS — null means idle (no recent renders)
    this.infoFps.textContent = `FPS: ${fps !== null ? fps : 0}`;
  }

  toggleUI(): void {
    this.controlsPanel.classList.toggle('hidden');
  }

  toggleInfo(): void {
    this.infoBar.classList.toggle('hidden');
  }

  toggleHelp(): void {
    // Check whether completing 'toggle-help' would finish the tutor.
    // If so, suppress the immediate hide and let the fade sequence handle dismissal.
    const wasFinished = this.tutorFinished;
    this.markTutorAction('toggle-help');
    const justFinished = !wasFinished && this.tutorFinished;
    if (!justFinished) {
      this.helpOverlay.classList.toggle('hidden');
    }
    // (If justFinished, the fade timeout set in markTutorAction will hide it instead.)
  }

  /**
   * Record that the user performed a trackable action.
   * Idempotent — safe to call on every event, not just the first.
   * Called from main.ts (for reset / toggle-ui) and Controls.toggleHelp() (for toggle-help).
   * InputHandler fires this via the onAction callback for all other actions.
   */
  markTutorAction(action: string): void {
    if (this.tutorFinished || this.tutorCompleted.has(action)) return;

    this.tutorCompleted.add(action);

    // Animate the dot for this action: blink green, then remove it
    const row = this.helpOverlay.querySelector(`[data-action="${action}"]`);
    const dot = row?.querySelector('.tutor-dot') as HTMLElement | null;
    if (dot) {
      dot.classList.add('completing');
      // Leave the dot in the DOM so its space is preserved — the animation's
      // "forwards" fill keeps it at opacity 0 / scale 0 without shifting the text.
    }

    // Check if every action is now done
    if (TUTOR_ACTIONS.every(a => this.tutorCompleted.has(a))) {
      this.tutorFinished = true;
      // Wait for the last dot to finish blinking, then fade the whole overlay
      setTimeout(() => {
        this.helpOverlay.classList.add('tutor-fading');
        this.helpOverlay.addEventListener('animationend', () => {
          this.helpOverlay.classList.remove('tutor-fading');
          this.helpOverlay.classList.add('hidden');
        }, { once: true });
      }, 450);
    }
  }

  private attachListeners(): void {
    this.selectFractal.addEventListener('change', () => {
      const type = parseInt(this.selectFractal.value, 10);
      this.uniforms.fractalType = type;
      this.updateJuliaVisibility();
      this.updateColorSchemeAvailability();
      this.syncInfoFractal();
      this.onFractalChange(type);
    });

    this.juliaReInput.addEventListener('input', () => {
      this.uniforms.juliaRe = parseFloat(this.juliaReInput.value) || 0;
      this.onParamChange();
    });

    this.juliaImInput.addEventListener('input', () => {
      this.uniforms.juliaIm = parseFloat(this.juliaImInput.value) || 0;
      this.onParamChange();
    });

    this.selectColor.addEventListener('change', () => {
      this.uniforms.colorScheme = parseInt(this.selectColor.value, 10);
      this.onParamChange();
    });

    this.rangeIterations.addEventListener('input', () => {
      const v = parseInt(this.rangeIterations.value, 10);
      this.uniforms.maxIterations = v;
      this.labelIterations.textContent = String(v);
      this.onParamChange();
    });

    this.btnReset.addEventListener('click', () => this.onReset());
  }

  private syncFromUniforms(): void {
    this.selectFractal.value   = String(this.uniforms.fractalType);
    this.selectColor.value     = String(this.uniforms.colorScheme);
    this.rangeIterations.value = String(this.uniforms.maxIterations);
    this.labelIterations.textContent = String(this.uniforms.maxIterations);
    this.juliaReInput.value    = String(this.uniforms.juliaRe);
    this.juliaImInput.value    = String(this.uniforms.juliaIm);
    this.updateJuliaVisibility();
    this.updateColorSchemeAvailability();
    this.syncInfoFractal();
  }

  private updateJuliaVisibility(): void {
    if (this.uniforms.fractalType === 1) {
      this.juliaPanelEl.classList.add('visible');
    } else {
      this.juliaPanelEl.classList.remove('visible');
    }
  }

  // Newton uses root-convergence colouring (not escape-time), so the palette
  // selector is meaningless for it. Disable it to avoid confusing the user.
  private updateColorSchemeAvailability(): void {
    const isNewton = this.uniforms.fractalType === 3;
    this.selectColor.disabled = isNewton;
    this.selectColor.title = isNewton
      ? 'Newton uses fixed root colours — palette does not apply'
      : '';
  }

  private syncInfoFractal(): void {
    this.infoFractal.textContent = FRACTAL_NAMES[this.uniforms.fractalType] ?? '';
  }
}
