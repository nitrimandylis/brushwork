import { blur, padMirror, type Image } from "./image";
import { STYLES, type Style, type StyleName } from "./styles";

export type PaintOptions = {
  style: StyleName;
  brush: number; // multiplies the whole radius ladder
  detail: number; // higher = pickier = more strokes
  seed: number;
};

export type PaintResult = {
  canvas: Float32Array; // RGB, 0-255, one float per channel
  coverage: Uint8Array; // 1 where at least one stroke landed
  width: number;
  height: number;
  strokes: number;
};

const MIN_STROKE_STEPS = 4;
const MAX_STROKE_STEPS = 10;
const BLUR_FACTOR = 0.5; // the reference image a layer paints towards
const CURVATURE_FILTER = 0.5; // 1 = a stroke turns freely, 0 = it never turns
const BASE_THRESHOLD = 25; // mean colour error a grid cell needs before it earns a stroke

// Small deterministic RNG so --seed reproduces a render exactly.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function luminance(data: Uint8Array, p: number): number {
  const i = p * 3;
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
}

// Euclidean RGB distance between the canvas and the reference at one pixel.
function canvasError(canvas: Float32Array, ref: Uint8Array, p: number): number {
  const i = p * 3;
  const dr = canvas[i] - ref[i];
  const dg = canvas[i + 1] - ref[i + 1];
  const db = canvas[i + 2] - ref[i + 2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function colourError(ref: Uint8Array, p: number, r: number, g: number, b: number): number {
  const i = p * 3;
  const dr = r - ref[i];
  const dg = g - ref[i + 1];
  const db = b - ref[i + 2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// Sobel gradient of the reference luminance. Strokes run across this, which is
// why paint appears to follow the form of what it is painting.
function gradient(ref: Uint8Array, x: number, y: number, w: number, h: number): [number, number] {
  const x0 = x > 0 ? x - 1 : 0;
  const x1 = x < w - 1 ? x + 1 : w - 1;
  const y0 = y > 0 ? y - 1 : 0;
  const y1 = y < h - 1 ? y + 1 : h - 1;
  const tl = luminance(ref, y0 * w + x0);
  const tc = luminance(ref, y0 * w + x);
  const tr = luminance(ref, y0 * w + x1);
  const ml = luminance(ref, y * w + x0);
  const mr = luminance(ref, y * w + x1);
  const bl = luminance(ref, y1 * w + x0);
  const bc = luminance(ref, y1 * w + x);
  const br = luminance(ref, y1 * w + x1);
  const gx = tr + 2 * mr + br - (tl + 2 * ml + bl);
  const gy = bl + 2 * bc + br - (tl + 2 * tc + tr);
  return [gx, gy];
}

// Walk a stroke outwards from its seed, re-steering at every step and stopping
// early once the canvas underneath already matches the reference better than
// this stroke's own colour would.
function strokePath(
  canvas: Float32Array,
  ref: Uint8Array,
  seed: number,
  radius: number,
  maxSteps: number,
  w: number,
  h: number,
  rng: () => number,
): number[] {
  const sx = seed % w;
  const sy = (seed - sx) / w;
  const i = seed * 3;
  const cr = ref[i];
  const cg = ref[i + 1];
  const cb = ref[i + 2];

  const points = [sx, sy];
  let x = sx;
  let y = sy;
  let lastDx = 0;
  let lastDy = 0;

  const minSteps = Math.min(MIN_STROKE_STEPS, maxSteps - 1);

  for (let step = 1; step <= maxSteps; step++) {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) break;
    const p = iy * w + ix;

    if (step > minSteps && canvasError(canvas, ref, p) < colourError(ref, p, cr, cg, cb)) {
      break;
    }

    const [gx, gy] = gradient(ref, ix, iy, w, h);
    const mag = Math.sqrt(gx * gx + gy * gy);

    let dx: number;
    let dy: number;
    if (mag < 1e-6) {
      // Flat region: no form to follow, so keep going straight, or pick a
      // direction if this is the first step. Without this, flat sky is dots.
      if (lastDx === 0 && lastDy === 0) {
        const angle = rng() * Math.PI * 2;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
      } else {
        dx = lastDx;
        dy = lastDy;
      }
    } else {
      dx = -gy / mag;
      dy = gx / mag;
      if (lastDx * dx + lastDy * dy < 0) {
        dx = -dx;
        dy = -dy;
      }
      dx = CURVATURE_FILTER * dx + (1 - CURVATURE_FILTER) * lastDx;
      dy = CURVATURE_FILTER * dy + (1 - CURVATURE_FILTER) * lastDy;
      const norm = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= norm;
      dy /= norm;
    }

    x += radius * dx;
    y += radius * dy;
    lastDx = dx;
    lastDy = dy;
    points.push(x, y);
  }

  return points;
}

// One round dab of paint with a one-pixel soft edge.
function stamp(
  canvas: Float32Array,
  coverage: Uint8Array,
  cx: number,
  cy: number,
  radius: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
  multiply: boolean,
  w: number,
  h: number,
): void {
  let x0 = Math.floor(cx - radius);
  let x1 = Math.ceil(cx + radius);
  let y0 = Math.floor(cy - radius);
  let y1 = Math.ceil(cy + radius);
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > w - 1) x1 = w - 1;
  if (y1 > h - 1) y1 = h - 1;

  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > radius) continue;
      const edge = radius - dist;
      const a = alpha * (edge < 1 ? edge : 1);
      if (a <= 0) continue;

      const p = y * w + x;
      const i = p * 3;
      coverage[p] = 1;
      if (multiply) {
        canvas[i] += ((canvas[i] * r) / 255 - canvas[i]) * a;
        canvas[i + 1] += ((canvas[i + 1] * g) / 255 - canvas[i + 1]) * a;
        canvas[i + 2] += ((canvas[i + 2] * b) / 255 - canvas[i + 2]) * a;
      } else {
        canvas[i] += (r - canvas[i]) * a;
        canvas[i + 1] += (g - canvas[i + 1]) * a;
        canvas[i + 2] += (b - canvas[i + 2]) * a;
      }
    }
  }
}

// One bristle: the stroke path shifted sideways, dabbed along its length.
function drawBristle(
  canvas: Float32Array,
  coverage: Uint8Array,
  points: number[],
  offset: number,
  radius: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
  multiply: boolean,
  w: number,
  h: number,
): void {
  const n = points.length / 2;
  if (n === 1) {
    stamp(canvas, coverage, points[0], points[1], radius, r, g, b, alpha, multiply, w, h);
    return;
  }
  for (let i = 0; i < n - 1; i++) {
    let ax = points[2 * i];
    let ay = points[2 * i + 1];
    let bx = points[2 * i + 2];
    let by = points[2 * i + 3];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    ax += nx * offset;
    ay += ny * offset;
    bx += nx * offset;
    by += ny * offset;
    const steps = Math.max(1, Math.ceil(len / (radius * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      stamp(canvas, coverage, ax + (bx - ax) * t, ay + (by - ay) * t, radius, r, g, b, alpha, multiply, w, h);
    }
  }
}

// A loaded brush is many hairs, each carrying slightly different paint. That is
// what makes a stroke read as a stroke instead of a slab of colour.
function renderStroke(
  canvas: Float32Array,
  coverage: Uint8Array,
  points: number[],
  colour: [number, number, number],
  radius: number,
  style: Style,
  rng: () => number,
  w: number,
  h: number,
): void {
  const strokeWidth = 2 * radius * style.widthFactor;
  const count = style.mono
    ? style.bristles
    : Math.min(24, Math.max(style.bristles, Math.round(strokeWidth / 5)));
  const bristleRadius = Math.max(0.6, (strokeWidth / count) * 0.7);
  const span = Math.max(0, strokeWidth - bristleRadius * 2);
  const multiply = style.blend === "multiply";

  let [r, g, b] = colour;
  let toneScale = 1;
  if (style.mono) {
    // Ink has one colour, so lightness has to become opacity instead.
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    toneScale = Math.min(1, Math.max(0.05, 1 - lum / 255));
    r = 26;
    g = 26;
    b = 26;
  }

  for (let i = 0; i < count; i++) {
    const offset = count === 1 ? 0 : (i / (count - 1) - 0.5) * span;
    const jr = r + (rng() - 0.5) * 2 * style.jitter;
    const jg = g + (rng() - 0.5) * 2 * style.jitter;
    const jb = b + (rng() - 0.5) * 2 * style.jitter;
    const alpha = style.alpha * toneScale * (0.6 + 0.4 * rng());
    drawBristle(canvas, coverage, points, offset, bristleRadius, jr, jg, jb, alpha, multiply, w, h);
  }
}

// Grid cell origins along one axis. The last cell is pulled flush with the far
// edge so the right and bottom strips get the same stroke density as the middle
// instead of a bare sliver.
function cellStarts(size: number, grid: number): number[] {
  const starts: number[] = [];
  for (let c = 0; c < size; c += grid) starts.push(c);
  const last = starts[starts.length - 1];
  if (last + grid > size && size > grid) starts[starts.length - 1] = size - grid;
  return starts;
}

// One coarse-to-fine pass: find the grid cells the canvas gets most wrong, and
// seed a stroke at the worst pixel in each.
function paintLayer(
  canvas: Float32Array,
  coverage: Uint8Array,
  ref: Image,
  radius: number,
  style: Style,
  threshold: number,
  rng: () => number,
): number {
  const w = ref.width;
  const h = ref.height;
  const grid = Math.max(1, Math.round(radius));
  const seeds: number[] = [];
  const xs = cellStarts(w, grid);
  const ys = cellStarts(h, grid);

  for (const cy of ys) {
    const yEnd = Math.min(cy + grid, h);
    for (const cx of xs) {
      const xEnd = Math.min(cx + grid, w);
      let sum = 0;
      let count = 0;
      let worst = -1;
      let worstPixel = cy * w + cx;
      for (let y = cy; y < yEnd; y++) {
        for (let x = cx; x < xEnd; x++) {
          const p = y * w + x;
          const err = canvasError(canvas, ref.data, p);
          sum += err;
          count++;
          if (err > worst) {
            worst = err;
            worstPixel = p;
          }
        }
      }
      if (sum / count > threshold) seeds.push(worstPixel);
    }
  }

  // Paint in a random order so strokes do not stack in scan-line order, which
  // reads as a visible grid.
  for (let i = seeds.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = seeds[i];
    seeds[i] = seeds[j];
    seeds[j] = tmp;
  }

  for (const seed of seeds) {
    const maxSteps = Math.max(1, Math.round(MAX_STROKE_STEPS * style.lengthFactor));
    const points = strokePath(canvas, ref.data, seed, radius, maxSteps, w, h, rng);
    const i = seed * 3;
    renderStroke(
      canvas,
      coverage,
      points,
      [ref.data[i], ref.data[i + 1], ref.data[i + 2]],
      radius,
      style,
      rng,
      w,
      h,
    );
  }

  return seeds.length;
}

// Watercolour dries darker where the wash met its edge. Approximated by
// darkening pixels that sit on a strong luminance edge of the finished paint.
function edgeDarken(canvas: Float32Array, w: number, h: number, strength: number): void {
  const grad = new Float32Array(w * h);
  const lum = (p: number) => 0.299 * canvas[p * 3] + 0.587 * canvas[p * 3 + 1] + 0.114 * canvas[p * 3 + 2];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const gx = lum(p + 1) - lum(p - 1);
      const gy = lum(p + w) - lum(p - w);
      const mag = Math.sqrt(gx * gx + gy * gy) / 64;
      grad[p] = mag > 1 ? 1 : mag;
    }
  }
  for (let p = 0; p < w * h; p++) {
    const k = 1 - strength * grad[p];
    const i = p * 3;
    canvas[i] *= k;
    canvas[i + 1] *= k;
    canvas[i + 2] *= k;
  }
}

export async function paint(src: Image, opts: PaintOptions): Promise<PaintResult> {
  const style = STYLES[opts.style];

  // Brush size is relative to the image, so a 1080p and a 6K copy of the same
  // photo come out looking like the same painting at two print sizes.
  const base = Math.max(2, (src.width / 120) * opts.brush);
  const radii = [4 * base, 2 * base, base];

  const margin = Math.ceil(radii[0]);
  const padded = await padMirror(src, margin);
  const w = padded.width;
  const h = padded.height;

  const canvas = new Float32Array(w * h * 3);
  const coverage = new Uint8Array(w * h);

  if (style.paper) {
    for (let i = 0; i < canvas.length; i += 3) {
      canvas[i] = style.paper[0];
      canvas[i + 1] = style.paper[1];
      canvas[i + 2] = style.paper[2];
    }
  } else {
    // Oil starts from a blurred underpainting rather than bare canvas. It is
    // how the medium is actually worked, and it stops the first coarse layer
    // from painting the whole frame at full stroke length.
    const under = await blur(padded, radii[0] * 2);
    for (let i = 0; i < canvas.length; i++) canvas[i] = under.data[i];
  }

  const rng = mulberry32(opts.seed);
  const threshold = BASE_THRESHOLD / opts.detail;
  let strokes = 0;

  for (const radius of radii) {
    const ref = await blur(padded, Math.max(0.5, BLUR_FACTOR * radius));
    strokes += paintLayer(canvas, coverage, ref, radius, style, threshold, rng);
  }

  if (style.edgeDarken > 0) edgeDarken(canvas, w, h, style.edgeDarken);

  return { ...crop(canvas, coverage, w, margin, src.width, src.height), strokes };
}

// Throw away the mirrored margin and hand back the picture the user asked for.
function crop(
  canvas: Float32Array,
  coverage: Uint8Array,
  paddedWidth: number,
  margin: number,
  width: number,
  height: number,
): { canvas: Float32Array; coverage: Uint8Array; width: number; height: number } {
  const outCanvas = new Float32Array(width * height * 3);
  const outCoverage = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const from = ((y + margin) * paddedWidth + margin) * 3;
    outCanvas.set(canvas.subarray(from, from + width * 3), y * width * 3);
    const fromPixel = (y + margin) * paddedWidth + margin;
    outCoverage.set(coverage.subarray(fromPixel, fromPixel + width), y * width);
  }
  return { canvas: outCanvas, coverage: outCoverage, width, height };
}
