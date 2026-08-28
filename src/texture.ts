// Procedural substrate and relief. Nothing here loads an asset: the weave and
// the paper grain are generated, so the look travels with the code.

export const GRAIN_SIZE = 1024; // the grain is one tile, wrapped across the image
const GRAIN_MASK = GRAIN_SIZE - 1;

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

// Value noise: random values on a lattice, smoothly interpolated between.
function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = smoothstep(x - xi);
  const fy = smoothstep(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return top + (bottom - top) * fy;
}

// One tile of substrate, values around 0.5. High means a raised thread or fibre
// that a dry brush catches on; low means a pit that stays bare.
//
// Generated as a wrapped tile rather than per pixel: a 6K frame is 28 million
// pixels and several octaves of noise each would cost more than the painting.
export function makeGrain(kind: "canvas" | "paper", featurePx: number, seed: number): Float32Array {
  const grain = new Float32Array(GRAIN_SIZE * GRAIN_SIZE);
  // Never finer than three pixels: below that the weave aliases into a dot
  // screen instead of fabric, and a preview stops predicting the full render.
  const period = Math.max(3, featurePx);
  const freq = (Math.PI * 2) / period;

  for (let y = 0; y < GRAIN_SIZE; y++) {
    for (let x = 0; x < GRAIN_SIZE; x++) {
      let value: number;
      if (kind === "canvas") {
        // Linen: a warp and a weft crossing, each wobbling slightly so the
        // weave never lines up into a perfect grid.
        const warpWobble = valueNoise(x / (period * 8), y / (period * 8), seed) - 0.5;
        const weftWobble = valueNoise(x / (period * 8) + 31, y / (period * 8) + 17, seed) - 0.5;
        const warp = Math.sin((x + warpWobble * period) * freq);
        const weft = Math.sin((y + weftWobble * period) * freq);
        value = 0.5 + 0.22 * warp + 0.22 * weft;
      } else {
        // Cold-press paper: no direction to it, just irregular fibre at two
        // scales.
        const coarse = valueNoise(x / period, y / period, seed);
        const fine = valueNoise(x / (period * 0.4) + 7, y / (period * 0.4) + 3, seed + 1);
        value = 0.35 * coarse + 0.65 * fine;
      }
      grain[y * GRAIN_SIZE + x] = Math.min(1, Math.max(0, value));
    }
  }
  return grain;
}

export function grainAt(grain: Float32Array, x: number, y: number): number {
  return grain[((y & GRAIN_MASK) << 10) + (x & GRAIN_MASK)];
}

// The tooth of the substrate showing through wherever the paint is thin. Thick
// paint fills the weave and hides it, which is why this is masked by thickness.
export function applySubstrate(
  canvas: Float32Array,
  thickness: Float32Array,
  grain: Float32Array,
  width: number,
  height: number,
  strength: number,
): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const bare = 1 - Math.min(1, thickness[p]);
      const shade = 1 - strength * (grainAt(grain, x, y) - 0.5) * 2 * (0.35 + 0.65 * bare);
      const i = p * 3;
      canvas[i] *= shade;
      canvas[i + 1] *= shade;
      canvas[i + 2] *= shade;
    }
  }
}

// Light the paint as a physical surface: thick strokes stand proud and catch
// the light on one side, and cast a little shade on the other.
export function applyRelief(
  canvas: Float32Array,
  thickness: Float32Array,
  width: number,
  height: number,
  strength: number,
): void {
  // Soften the height field first, otherwise the light picks out the edge of
  // every individual dab rather than the ridge of the stroke.
  const smooth = new Float32Array(thickness.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      smooth[p] =
        (thickness[p - width - 1] +
          thickness[p - width] +
          thickness[p - width + 1] +
          thickness[p - 1] +
          thickness[p] +
          thickness[p + 1] +
          thickness[p + width - 1] +
          thickness[p + width] +
          thickness[p + width + 1]) /
        9;
    }
  }

  // Light from the upper left, the convention every painting photograph uses.
  const lx = -0.6;
  const ly = -0.6;
  const slope = 1.2;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const nx = -(smooth[p + 1] - smooth[p - 1]) * slope;
      const ny = -(smooth[p + width] - smooth[p - width]) * slope;
      const norm = Math.sqrt(nx * nx + ny * ny + 1);
      // Only the directional part of the lighting is used. Including the
      // straight-on term as well means every sloped pixel comes out darker than
      // flat paint, which drags the whole picture down rather than lighting one
      // side of a ridge and shading the other.
      const tilt = (nx * lx + ny * ly) / norm;
      let lit = 1 + strength * tilt;
      if (lit < 0.65) lit = 0.65;
      if (lit > 1.45) lit = 1.45;
      const i = p * 3;
      canvas[i] *= lit;
      canvas[i + 1] *= lit;
      canvas[i + 2] *= lit;
    }
  }
}
