#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { basename, dirname, extname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import sharp, { type OverlayOptions } from "sharp";
import { load, save, extractIcc, toBytes } from "./image";
import { paint } from "./paint";
import { STYLES, isStyleName, type StyleName } from "./styles";

const PREVIEW_WIDTH = 1200;
const SHEET_CELL_WIDTH = 900;
const SHEET_BRUSHES = [1, 2];

const HELP = `brushwork - turn a photograph into a painting made of brush strokes

usage:
  brushwork <image...> [options]

options:
  --style <name>   oil, water or ink            (default: oil)
  --brush <n>      stroke size multiplier       (default: 1)
  --detail <n>     higher paints more strokes   (default: 1)
  --seed <n>       same seed, same painting     (default: 1)
  --preview        render small and fast, for dialling flags in
  --sheet          one grid of every style at two brush sizes
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

async function expandInputs(patterns: string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const pattern of patterns) {
    // The shell usually expands globs first; this is for quoted ones.
    if (pattern.includes("*")) {
      const glob = new Bun.Glob(basename(pattern));
      for await (const match of glob.scan({ cwd: dirname(pattern) || "." })) {
        paths.push(join(dirname(pattern) || ".", match));
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

async function renderSheet(input: string, out: string | undefined, seed: number, detail: number): Promise<Result> {
  const started = Date.now();
  const src = await load(input, SHEET_CELL_WIDTH);
  const cells: { buffer: Buffer; label: string }[] = [];
  let strokes = 0;

  for (const brush of SHEET_BRUSHES) {
    for (const style of Object.keys(STYLES) as StyleName[]) {
      const result = await paint(src, { style, brush, detail, seed });
      strokes += result.strokes;
      const buffer = await sharp(toBytes(result.canvas), {
        raw: { width: result.width, height: result.height, channels: 3 },
      })
        .png()
        .toBuffer();
      cells.push({ buffer, label: `${style}  --brush ${brush}` });
    }
  }

  const cols = Object.keys(STYLES).length;
  const rows = SHEET_BRUSHES.length;
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
    labels += `<text x="${x}" y="${y + cellH + 23}" font-family="monospace" font-size="18" fill="#e6e6e6">${cell.label}</text>`;
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
  opts: { brush: number; detail: number; seed: number; preview: boolean; jpeg: boolean },
  out: string | undefined,
  manyInputs: boolean,
): Promise<Result> {
  const started = Date.now();
  const src = await load(input, opts.preview ? PREVIEW_WIDTH : undefined);
  const result = await paint(src, { style, brush: opts.brush, detail: opts.detail, seed: opts.seed });
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

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      style: { type: "string", default: "oil" },
      brush: { type: "string", default: "1" },
      detail: { type: "string", default: "1" },
      seed: { type: "string", default: "1" },
      preview: { type: "boolean", default: false },
      sheet: { type: "boolean", default: false },
      jpeg: { type: "boolean", default: false },
      out: { type: "string", short: "o" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "V", default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log((await import("../package.json")).version);
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
  const seed = Number(values.seed);
  if (!(brush > 0)) die("--brush must be a positive number");
  if (!(detail > 0)) die("--detail must be a positive number");
  if (!Number.isFinite(seed)) die("--seed must be a number");

  const results: Result[] = [];
  for (const input of inputs) {
    if (!(await Bun.file(input).exists())) die(`no such file: ${input}`);
    const result = values.sheet
      ? await renderSheet(input, values.out, seed, detail)
      : await renderOne(
          input,
          values.style,
          { brush, detail, seed, preview: values.preview, jpeg: values.jpeg },
          values.out,
          inputs.length > 1,
        );
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
