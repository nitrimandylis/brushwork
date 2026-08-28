import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Image = {
  data: Uint8Array; // RGB, three bytes per pixel, row by row
  width: number;
  height: number;
};

// Load an image as raw RGB. Transparency is flattened onto white and greyscale
// is promoted to sRGB, so the rest of the program always sees three channels.
export async function load(path: string, maxWidth?: number): Promise<Image> {
  let pipeline = sharp(path).flatten({ background: "#ffffff" }).toColourspace("srgb");
  if (maxWidth) pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
  const { data, info } = await pipeline.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

// Gaussian blur of an already-loaded raster. Goes back through sharp (libvips)
// rather than blurring by hand, because at 6K a hand-rolled blur is the slowest
// thing in the program.
export async function blur(img: Image, sigma: number): Promise<Image> {
  const { data, info } = await sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: 3 },
  })
    .blur(Math.max(0.3, sigma))
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

// The source file's ICC profile, written to a temp file so sharp can attach it
// to the output. Without this a P3 wallpaper comes back looking washed out.
export async function extractIcc(path: string): Promise<string | null> {
  const meta = await sharp(path).metadata();
  if (!meta.icc) return null;
  const iccPath = join(tmpdir(), `brushwork-${process.pid}.icc`);
  await writeFile(iccPath, meta.icc);
  return iccPath;
}

// Mirror the image outwards by `margin` pixels. Strokes can then be seeded in
// the margin and paint across the real edge, instead of every border ending up
// thinner than the rest of the picture. The margin is cropped off afterwards.
export async function padMirror(img: Image, margin: number): Promise<Image> {
  const { data, info } = await sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: 3 },
  })
    .extend({ top: margin, bottom: margin, left: margin, right: margin, extendWith: "mirror" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

export function toBytes(canvas: Float32Array): Uint8Array {
  const out = new Uint8Array(canvas.length);
  for (let i = 0; i < canvas.length; i++) {
    const v = canvas[i];
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v + 0.5;
  }
  return out;
}

export async function save(
  canvas: Float32Array,
  width: number,
  height: number,
  outPath: string,
  opts: { jpeg: boolean; icc: string | null },
): Promise<void> {
  let pipeline = sharp(toBytes(canvas), { raw: { width, height, channels: 3 } });
  if (opts.icc) pipeline = pipeline.withIccProfile(opts.icc);
  pipeline = opts.jpeg ? pipeline.jpeg({ quality: 95 }) : pipeline.png({ compressionLevel: 9 });
  await pipeline.toFile(outPath);
}
