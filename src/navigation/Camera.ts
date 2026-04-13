/**
 * Camera.ts — view state for the fractal explorer
 *
 * The "camera" is not a 3D camera — it describes which rectangular window
 * of the complex plane is currently visible.  Three numbers fully define it:
 *
 *   centerRe / centerIm — the complex number at the centre of the screen
 *   zoom                — height of the visible region in complex units
 *                         (smaller = more zoomed in, like a map scale)
 *   rotation            — view rotation in radians
 *
 * Example: the default Mandelbrot view has
 *   center = (-0.5, 0),  zoom = 3.0  (shows Re ∈ [−2, 1], Im ∈ [−1.5, 1.5])
 */

export interface Camera {
  centerRe: number;
  centerIm: number;
  zoom: number;        // complex units visible in the canvas height
  rotation: number;   // radians; positive = counter-clockwise
}

// Default starting views for each fractal, indexed 0–4
const DEFAULT_VIEWS: Camera[] = [
  // 0 — Mandelbrot: classic full view centred slightly left
  { centerRe: -0.5,   centerIm: 0.0,    zoom: 3.0,  rotation: 0 },
  // 1 — Julia: zoomed to show the full filled Julia set
  { centerRe: 0.0,    centerIm: 0.0,    zoom: 3.2,  rotation: 0 },
  // 2 — Burning Ship: ship is in the lower half-plane, so we look down
  { centerRe: -0.4,   centerIm: -0.55,  zoom: 3.5,  rotation: 0 },
  // 3 — Newton: symmetric around origin
  { centerRe: 0.0,    centerIm: 0.0,    zoom: 3.0,  rotation: 0 },
  // 4 — Tricorn: full view
  { centerRe: -0.25,  centerIm: 0.0,    zoom: 3.2,  rotation: 0 },
  // 5 — Custom (Multibrot n=3)
  { centerRe: 0.0,    centerIm: 0.0,    zoom: 3.0,  rotation: 0 },
  // 6 — Magnet I: main body spans roughly ±3 on Re and Im
  { centerRe: 1.0,    centerIm: 0.0,    zoom: 6.0,  rotation: 0 },
  // 7 — Magnet II: cubic map is slightly wider
  { centerRe: 0.0,    centerIm: 0.0,    zoom: 7.0,  rotation: 0 },
  // 8 — Phoenix: similar footprint to Mandelbrot, shifted slightly left
  { centerRe: -0.5,   centerIm: 0.0,    zoom: 3.0,  rotation: 0 },
  // 9 — Celtic: near-identical footprint to Mandelbrot
  { centerRe: -0.5,   centerIm: 0.0,    zoom: 3.5,  rotation: 0 },
  // 10 — sin(z)+c: interesting bubbles span Re ∈ [−π, π], Im ∈ [−3, 3]
  { centerRe: 0.0,    centerIm: 0.0,    zoom: 10.0, rotation: 0 },
  // 11 — e^z+c: fan structure sits left of the imaginary axis
  { centerRe: -1.5,   centerIm: 0.0,    zoom: 8.0,  rotation: 0 },
  // 12 — Rational (λ/z²): McMullen-style ring around origin
  { centerRe: 0.0,    centerIm: 0.0,    zoom: 4.0,  rotation: 0 },
];

export function defaultCamera(fractalType: number): Camera {
  return { ...DEFAULT_VIEWS[fractalType] ?? DEFAULT_VIEWS[0] };
}

/**
 * Zoom the camera towards a specific point in complex-plane coordinates.
 *
 * @param camera  current view state (mutated in place)
 * @param factor  multiply zoom by this (< 1 = zoom in, > 1 = zoom out)
 * @param targetRe  complex-plane Re coordinate to zoom towards
 * @param targetIm  complex-plane Im coordinate to zoom towards
 */
export function zoomAt(
  camera: Camera,
  factor: number,
  targetRe: number,
  targetIm: number,
): void {
  // Move centre towards the target proportionally to the zoom change.
  // This ensures the point under the cursor stays fixed on screen.
  const scale = 1 - factor;
  camera.centerRe += (targetRe - camera.centerRe) * scale;
  camera.centerIm += (targetIm - camera.centerIm) * scale;
  camera.zoom *= factor;

  // Clamp zoom. With double-double arithmetic in the shader we can go to ~1e-14
  // before the GPU's float32 iteration precision becomes the bottleneck.
  camera.zoom = Math.max(1e-14, Math.min(camera.zoom, 20));
}

/**
 * Pan the camera by a delta in complex-plane units.
 */
export function panBy(camera: Camera, dRe: number, dIm: number): void {
  // Delta is already in complex-plane coordinates — add directly.
  // Callers are responsible for rotating screen-space deltas into complex space first
  // (pixelDeltaToComplex does this for mouse/touch; keyboard callers do it inline).
  camera.centerRe += dRe;
  camera.centerIm += dIm;
}

/**
 * Convert a canvas pixel offset (relative to canvas centre) to
 * complex-plane displacement, accounting for zoom, aspect ratio, and rotation.
 */
export function pixelDeltaToComplex(
  camera: Camera,
  canvas: HTMLCanvasElement,
  dx: number,
  dy: number,
): [number, number] {
  // dx/dy are CSS pixels (from e.clientX/Y); canvas.clientHeight is also CSS pixels,
  // so this ratio is display-density-independent and gives true 1:1 panning.
  const scale = camera.zoom / canvas.clientHeight;
  // dx: positive = right → Re increases (natural)
  // dy: positive = down in DOM → we pan upward (see content above) → Im increases
  // No Y-flip here; InputHandler passes raw DOM dy.
  const uRe = dx * scale;
  const uIm = dy * scale;

  // Rotate the screen-space delta into complex-plane space using a standard CCW
  // rotation by camera.rotation. This mirrors what the fragment shader does when
  // mapping pixels → complex coordinates, so the pan tracks the finger correctly
  // regardless of the current view rotation.
  //
  // CCW rotation matrix by θ:  [ cos θ  -sin θ ]
  //                             [ sin θ   cos θ ]
  const cos = Math.cos(camera.rotation);
  const sin = Math.sin(camera.rotation);
  return [
    uRe * cos - uIm * sin,
    uRe * sin + uIm * cos,
  ];
}

/**
 * Convert an absolute canvas pixel position to a complex-plane coordinate.
 * Matches the coordinate transform in the fragment shader exactly.
 */
export function pixelToComplex(
  camera: Camera,
  canvas: HTMLCanvasElement,
  px: number,
  py: number,
): [number, number] {
  // Normalise: (0,0) = canvas centre; y flipped (WebGL y-up, DOM y-down)
  const uvX = (px - canvas.width  * 0.5) / canvas.height;
  const uvY = (py - canvas.height * 0.5) / canvas.height;

  // Scale by zoom
  const sX =  uvX * camera.zoom;
  const sY = -uvY * camera.zoom;  // flip Y

  // Rotate
  const cos = Math.cos(camera.rotation);
  const sin = Math.sin(camera.rotation);
  const rX = sX * cos - sY * sin;
  const rY = sX * sin + sY * cos;

  return [rX + camera.centerRe, rY + camera.centerIm];
}
