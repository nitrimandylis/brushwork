import { expect, test } from "bun:test";
import type { Image } from "../src/image";
import { paint } from "../src/paint";

// A synthetic picture rather than a committed photo: a colour ramp, a fine
// ripple so there is detail everywhere the way a photograph has, and a dark
// block for a hard edge.
function fixture(): Image {
  const width = 400;
  const height = 300;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const inBlock = x > 120 && x < 260 && y > 90 && y < 200;
      const ripple = 34 * Math.sin(x / 7) * Math.cos(y / 9);
      const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
      data[i] = clamp(inBlock ? 30 + ripple : (x / width) * 255 + ripple);
      data[i + 1] = clamp(inBlock ? 40 + ripple : (y / height) * 255 + ripple);
      data[i + 2] = clamp(inBlock ? 60 + ripple : 140 + ripple);
    }
  }
  return { data, width, height };
}

function meanChannels(pixels: ArrayLike<number>): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  const count = pixels.length / 3;
  for (let i = 0; i < pixels.length; i += 3) {
    r += pixels[i];
    g += pixels[i + 1];
    b += pixels[i + 2];
  }
  return [r / count, g / count, b / count];
}

function coverageFraction(coverage: Uint8Array): number {
  let painted = 0;
  for (let i = 0; i < coverage.length; i++) painted += coverage[i];
  return painted / coverage.length;
}

const src = fixture();
const defaults = { brush: 1, detail: 1, seed: 1 } as const;

test("the output is the same size as the input", async () => {
  const result = await paint(src, { style: "oil", ...defaults });
  expect(result.width).toBe(src.width);
  expect(result.height).toBe(src.height);
  expect(result.canvas.length).toBe(src.width * src.height * 3);
});

test("strokes cover the canvas", async () => {
  const oil = await paint(src, { style: "oil", ...defaults });
  const water = await paint(src, { style: "water", ...defaults });
  const ink = await paint(src, { style: "ink", ...defaults });
  expect(coverageFraction(oil.coverage)).toBeGreaterThan(0.5);
  expect(coverageFraction(water.coverage)).toBeGreaterThan(0.9);
  expect(coverageFraction(ink.coverage)).toBeGreaterThan(0.5);
});

test("the painting is still of the same picture", async () => {
  const result = await paint(src, { style: "oil", ...defaults });
  const before = meanChannels(src.data);
  const after = meanChannels(result.canvas);
  for (let channel = 0; channel < 3; channel++) {
    expect(Math.abs(after[channel] - before[channel])).toBeLessThan(12);
  }
});

test("a seed reproduces a painting exactly, and a different seed does not", async () => {
  const a = await paint(src, { style: "oil", brush: 1, detail: 1, seed: 7 });
  const b = await paint(src, { style: "oil", brush: 1, detail: 1, seed: 7 });
  const c = await paint(src, { style: "oil", brush: 1, detail: 1, seed: 8 });
  expect(a.canvas).toEqual(b.canvas);
  expect(a.canvas).not.toEqual(c.canvas);
});

test("a bigger brush paints fewer, larger strokes", async () => {
  const fine = await paint(src, { style: "oil", brush: 0.5, detail: 1, seed: 1 });
  const broad = await paint(src, { style: "oil", brush: 2, detail: 1, seed: 1 });
  expect(fine.strokes).toBeGreaterThan(broad.strokes);
});

test("more detail paints more strokes", async () => {
  const plain = await paint(src, { style: "oil", brush: 1, detail: 1, seed: 1 });
  const detailed = await paint(src, { style: "oil", brush: 1, detail: 3, seed: 1 });
  expect(detailed.strokes).toBeGreaterThan(plain.strokes);
});
