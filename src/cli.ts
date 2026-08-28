#!/usr/bin/env node
import { parseArgs } from "node:util";
import { basename, dirname, extname, join, resolve } from "node:path";
import { mkdir, readdir, access } from "node:fs/promises";
import sharp, { type OverlayOptions } from "sharp";
import { load, save, extractIcc, toBytes } from "./image";
import { paint } from "./paint";
import { STYLES, isStyleName, type StyleName } from "./styles";

const VERSION = "0.1.0";
const PREVIEW_WIDTH = 1200;
const SHEET_CELL_WIDTH = 900;
const SHEET_BRUSHES = [1, 2];
const SHEET_ZOOM = 3; // magnification of the detail inset

const HELP = `brushwork - turn a photograph into a painting made of brush strokes

usage:
  brushwork <image...> [options]

options:
  --style <name>   oil, water or ink            (default: oil)
  --brush <n>      stroke size multiplier       (default: 1)
  --detail <n>     how fine the smallest brush goes, higher keeps more
                   of the original detail        (default: 1)
  --texture <n>    canvas weave, dry brush and relief, 0 turns it off
                                                 (default: 1)
  --seed <n>       same seed, same painting     (default: 1)
  --preview        render small and fast, for dialling flags in
  --sheet          one grid of every style at two brush sizes, textured and
                   bare, each cell carrying a 3x detail inset so the texture
                   survives being looked at scaled down
  --jpeg           write jpeg instead of png
  -o, --out <path> output file, or a directory for several inputs
  --json           print results as json
  -h, --help       show this
  -V, --version    show the version
`;

type Result = {
  input: string;
  output: string;
  style: string;
  width: number;
  height: number;
  strokes: number;
  seconds: number;
};

function die(message: string): never {
  console.error(`brushwork: ${message}`);
  process.exit(1);
}

// Only `*` is supported, which is all a shell leaves for us to handle anyway.
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

async function expandInputs(patterns: string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const pattern of patterns) {
    // The shell usually expands globs first; this is for quoted ones.
    if (pattern.includes("*")) {
      const dir = dirname(pattern) || ".";
      const matcher = globToRegExp(basename(pattern));
      for (const entry of await readdir(dir)) {
        if (matcher.test(entry)) paths.push(join(dir, entry));
      }
    } else {
      paths.push(pattern);
    }
  }
  return paths.sort();
}

// Where one render should land, given the -o the user did or did not pass.
async function outputPath(
  input: string,
  suffix: string,
  ext: string,
  out: string | undefined,
  manyInputs: boolean,
): Promise<string> {
  const name = `${basename(input, extname(input))}.${suffix}${ext}`;
  if (!out) return join(dirname(input), name);
  const looksLikeFile = !manyInputs && [".png", ".jpg", ".jpeg"].includes(extname(out).toLowerCase());
  if (looksLikeFile) return out;
  await mkdir(out, { recursive: true });
  return join(out, name);
}

// Where to take the magnified detail from. Texture shows itself in calm areas:
// a crop of the busiest part of the picture is all stroke and no surface, and a
// crop of solid black shows nothing at all. So this picks the flattest candidate
// that is not in shadow or blown out.
function pickDetailCrop(
  src: { data: Uint8Array; width: number; height: number },
  cropWidth: number,
  cropHeight: number,
): { left: number; top: number } {
  const candidates: { left: number; top: number; spread: number; mean: number }[] = [];

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const left = Math.round(((src.width - cropWidth) * col) / 2);
      const top = Math.round(((src.height - cropHeight) * row) / 2);

      let sum = 0;
      let sumSquares = 0;
      let count = 0;
      for (let y = top; y < top + cropHeight; y += 2) {
        for (let x = left; x < left + cropWidth; x += 2) {
          const i = (y * src.width + x) * 3;
          const lum = 0.299 * src.data[i] + 0.587 * src.data[i + 1] + 0.114 * src.data[i + 2];
          sum += lum;
          sumSquares += lum * lum;
          count++;
        }
      }
      const mean = sum / count;
      candidates.push({
        left,
        top,
        mean,
        spread: Math.sqrt(Math.max(0, sumSquares / count - mean * mean)),
      });
    }
  }

  // Drop anything in deep shadow or blown out, where there is nothing to see.
  const usable = candidates.filter((c) => c.mean > 30 && c.mean < 225);
  const pool = usable.length > 0 ? usable : candidates;
  pool.sort((a, b) => a.spread - b.spread);
  // A quarter of the way up the range: calm enough that the surface shows,
  // busy enough that there is still some brushwork in frame.
  const chosen = pool[Math.floor(pool.length * 0.25)];
  return { left: chosen.left, top: chosen.top };
}

async function renderSheet(
  input: string,
  out: string | undefined,
  seed: number,
  detail: number,
  texture: number,
): Promise<Result> {
  const started = Date.now();
  const src = await load(input, SHEET_CELL_WIDTH);
  const cells: { buffer: Buffer; detail: Buffer; label: string }[] = [];
  let strokes = 0;

  // A sheet is far wider than any window, so it is looked at scaled down, and
  // scaling is exactly what destroys canvas weave and stroke relief. Each cell
  // therefore carries a magnified crop of its own centre: shrink the sheet to
  // fit and that inset lands back at roughly one to one.
  const insetWidth = Math.round(src.width / 3);
  const insetHeight = Math.round((insetWidth * src.height) / src.width);
  const cropWidth = Math.round(insetWidth / SHEET_ZOOM);
  const cropHeight = Math.round(insetHeight / SHEET_ZOOM);
  // One crop rectangle for every cell, so the six insets can be compared.
  const crop = pickDetailCrop(src, cropWidth, cropHeight);

  // Each brush size gets a textured row and a bare one, so the texture pass can
  // be judged against the paint underneath it rather than from memory. Asking
  // for no texture in the first place collapses that back to one row.
  const rowsSpec: { brush: number; texture: number }[] = [];
  for (const brush of SHEET_BRUSHES) {
    rowsSpec.push({ brush, texture });
    if (texture > 0) rowsSpec.push({ brush, texture: 0 });
  }

  for (const row of rowsSpec) {
    const brush = row.brush;
    for (const style of Object.keys(STYLES) as StyleName[]) {
      const result = await paint(src, { style, brush, detail, texture: row.texture, seed });
      strokes += result.strokes;
      const buffer = await sharp(toBytes(result.canvas), {
        raw: { width: result.width, height: result.height, channels: 3 },
      })
        .png()
        .toBuffer();
      const inset = await sharp(buffer)
        .extract({ left: crop.left, top: crop.top, width: cropWidth, height: cropHeight })
        .resize(insetWidth, insetHeight, { kernel: "nearest" })
        .png()
        .toBuffer();
      const texturePart = row.texture > 0 ? "" : "  --texture 0";
      cells.push({ buffer, detail: inset, label: `${style}  --brush ${brush}${texturePart}` });
    }
  }

  const cols = Object.keys(STYLES).length;
  const rows = rowsSpec.length;
  const cellW = src.width;
  const cellH = src.height;
  const pad = 12;
  const labelH = 34;
  const sheetW = cols * cellW + (cols + 1) * pad;
  const sheetH = rows * (cellH + labelH) + (rows + 1) * pad;

  const overlays: OverlayOptions[] = [];
  let labels = "";
  cells.forEach((cell, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = pad + col * (cellW + pad);
    const y = pad + row * (cellH + labelH + pad);
    overlays.push({ input: cell.buffer, left: x, top: y });
    const insetX = x + cellW - insetWidth - 12;
    const insetY = y + cellH - insetHeight - 12;
    overlays.push({ input: cell.detail, left: insetX, top: insetY });
    labels +=
      `<text x="${x}" y="${y + cellH + 23}" font-family="monospace" font-size="18" fill="#e6e6e6">${cell.label}</text>` +
      `<rect x="${insetX}" y="${insetY}" width="${insetWidth}" height="${insetHeight}" fill="none" stroke="#141414" stroke-width="3"/>` +
      `<text x="${insetX + 8}" y="${insetY + 22}" font-family="monospace" font-size="15" fill="#141414">${SHEET_ZOOM}x</text>`;
  });
  overlays.push({
    input: Buffer.from(`<svg width="${sheetW}" height="${sheetH}">${labels}</svg>`),
    left: 0,
    top: 0,
  });

  const path = await outputPath(input, "sheet", ".png", out, false);
  await sharp({
    create: { width: sheetW, height: sheetH, channels: 3, background: "#141414" },
  })
    .composite(overlays)
    .png()
    .toFile(path);

  return {
    input,
    output: path,
    style: "sheet",
    width: sheetW,
    height: sheetH,
    strokes,
    seconds: (Date.now() - started) / 1000,
  };
}

async function renderOne(
  input: string,
  style: StyleName,
  opts: { brush: number; detail: number; texture: number; seed: number; preview: boolean; jpeg: boolean },
  out: string | undefined,
  manyInputs: boolean,
): Promise<Result> {
  const started = Date.now();
  const src = await load(input, opts.preview ? PREVIEW_WIDTH : undefined);
  const result = await paint(src, {
    style,
    brush: opts.brush,
    detail: opts.detail,
    texture: opts.texture,
    seed: opts.seed,
  });
  const icc = await extractIcc(input);
  const suffix = opts.preview ? `${style}.preview` : style;
  const path = await outputPath(input, suffix, opts.jpeg ? ".jpg" : ".png", out, manyInputs);
  await save(result.canvas, result.width, result.height, path, { jpeg: opts.jpeg, icc });
  return {
    input,
    output: path,
    style,
    width: result.width,
    height: result.height,
    strokes: result.strokes,
    seconds: (Date.now() - started) / 1000,
  };
}

// parseArgs is strict, so an unrecognised flag throws rather than being silently
// ignored. That is the behaviour we want; the stack trace it comes with is not.
function parse() {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: OPTIONS,
    });
  } catch (error) {
    die(error instanceof Error ? error.message.split(".")[0]! : "bad arguments");
  }
}

const OPTIONS = {
  style: { type: "string", default: "oil" },
  brush: { type: "string", default: "1" },
  detail: { type: "string", default: "1" },
  texture: { type: "string", default: "1" },
  seed: { type: "string", default: "1" },
  preview: { type: "boolean", default: false },
  sheet: { type: "boolean", default: false },
  jpeg: { type: "boolean", default: false },
  out: { type: "string", short: "o" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "V", default: false },
} as const;

async function main(): Promise<void> {
  const { values, positionals } = parse();

  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log(VERSION);
    return;
  }

  const inputs = await expandInputs(positionals);
  if (inputs.length === 0) {
    console.log(HELP);
    process.exit(1);
  }
  if (!isStyleName(values.style)) {
    die(`unknown style "${values.style}". pick one of: ${Object.keys(STYLES).join(", ")}`);
  }

  const brush = Number(values.brush);
  const detail = Number(values.detail);
  const texture = Number(values.texture);
  const seed = Number(values.seed);
  if (!(brush > 0)) die("--brush must be a positive number");
  if (!(detail > 0)) die("--detail must be a positive number");
  if (!(texture >= 0)) die("--texture must be zero or more");
  if (!Number.isFinite(seed)) die("--seed must be a number");

  const results: Result[] = [];
  for (const input of inputs) {
    try {
      await access(input);
    } catch {
      die(`no such file: ${input}`);
    }
    let result: Result;
    try {
      result = values.sheet
        ? await renderSheet(input, values.out, seed, detail, texture)
        : await renderOne(
            input,
            values.style,
            { brush, detail, texture, seed, preview: values.preview, jpeg: values.jpeg },
            values.out,
            inputs.length > 1,
          );
    } catch (error) {
      // Anything sharp refuses to decode, plus unwritable output paths. A
      // consumer branches on the exit code, so this must not surface as a trace
      // on stderr and a zero exit.
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      die(`could not paint ${input}: ${reason}`);
    }
    results.push(result);
    if (!values.json) {
      console.log(
        `${resolve(result.input)} -> ${resolve(result.output)}  ${result.width}x${result.height}  ${result.style}  ${result.strokes} strokes  ${result.seconds.toFixed(1)}s`,
      );
    }
  }

  if (values.json) console.log(JSON.stringify(results, null, 2));
}

await main();
