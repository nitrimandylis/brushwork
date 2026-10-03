---
name: brushwork-cli
description: Repaint a photograph as a painting made of visible brush strokes, in oil, watercolour or pen and ink. Use when the user wants an image turned into a painting, a painterly or artistic version of a photo or wallpaper, an oil painting or watercolour or ink sketch effect, a non-photorealistic render, or mentions brushwork.
---

# brushwork

A command-line tool that repaints an image as brush strokes. File in, file out.

## Setup

`brushwork <image>` should be on PATH. If it is not, it has not been installed:
offer to run `bun install -g brushwork` (or `npm install -g brushwork`). For a
single render on a machine you do not want to install onto, `npx brushwork ...`
works, but it re-resolves the package every call, so install it before any
session that will run more than one or two. Inside a clone of the repo,
`bun src/cli.ts` works without installing anything.

Needs Node 18.17+. Its one dependency, sharp, ships prebuilt binaries.

## Everything runs unattended

There is no TUI, no picker, no server and no prompt. Every invocation renders and
exits, so all of it is safe to call from a tool call. The only thing to watch is
wall clock: see the costs below.

## Commands

There is one command. The image paths are positional, everything else is a flag.

```
brushwork tower.jpg --style oil --brush 1.4
brushwork tower.jpg --sheet
brushwork ~/wall/*.jpg --style ink -o painted/
brushwork tower.jpg --style water --json
```

| flag | what it does |
|---|---|
| `--style oil\|water\|ink` | the medium. default oil |
| `--brush <n>` | stroke size, scales the whole brush ladder. default 1 |
| `--detail <n>` | how fine the smallest brush goes. default 1 |
| `--texture <n>` | substrate, dry brush and relief, 0 to 1. default 1 |
| `--seed <n>` | same seed, same painting, exactly. default 1 |
| `--preview` | render at 1200px wide, about a second |
| `--sheet` | one grid of every style at two brush sizes, textured and bare |
| `--jpeg` | write jpeg instead of png |
| `-o, --out <path>` | output file, or a directory for several inputs |
| `--json` | print results as json instead of a human line |
| `-V, --version` | print the version |

## What each one costs

| | time |
|---|---|
| `--preview` | under a second |
| a full 4K render | 5 to 8 seconds |
| a full 5K/6K render | 50 seconds and up, disproportionately worse than 4K |
| `--sheet` | 4 to 6 seconds, it renders 12 cells, each 900px wide whatever `--preview` is set to |

Never fire a full-resolution render just to see whether a style suits an image.
Use `--preview`, or `--sheet` if the choice of style is the actual question. Say
so before starting a 5K or larger render, because a minute of silence reads as a
hang.

## Things that will bite you

- **It overwrites without asking.** Output is `<name>.<style>.png` beside the
  input, and a second run with the same flags silently replaces the first. Pass
  `-o` to a scratch directory when the user has not said where to put things.
- **`--detail` is not stroke count.** It sets how far down the brush ladder goes,
  which is what decides how much of the original picture survives. Turning it up
  past about 2 stops the result looking painted at all. If detail is being lost,
  this is the flag, not `--brush`.
- **`--brush` scales the whole ladder**, so it changes stroke size and character,
  not how many strokes there are. Bigger is bolder and blockier, not sparser.
- **A sheet has to be viewed at 100% to judge texture.** It is around 2700px
  wide, and shrinking it to fit a window destroys exactly the canvas weave and
  stroke relief it is meant to show. Each cell carries a 3x detail inset for that
  reason: read the inset, not the cell.
- **Ink is weak on dark, busy sources.** On a night scene it saturates towards a
  grey scribble because tone is near maximum everywhere and stroke density cannot
  vary. It reads well on mid-key and bright images. Do not offer ink for a dark
  wallpaper without warning that it may not work.
- **A faint halo can appear** in flat areas next to a high-contrast subject, most
  visibly a dark shape against bright sky. `--brush 0.7` reduces it. Nothing
  removes it; it is a known limitation, not a bug to report.
- **Renders are deterministic per seed**, so re-running the same command gives a
  byte-identical file. To get a different painting of the same photo, change
  `--seed`, not anything else.

## What it cannot do

- It does not know about swatch, or any wallpaper manager. Paint the file, then
  let the user add it to a theme themselves.
- There is no neural or style-transfer mode, and no reference-image input. The
  three styles are the whole set.
- It does not do video, batch presets, or in-place editing.

## `--json`

One JSON array on stdout, one object per input, nothing else. Errors go to stderr
with a non-zero exit, so branch on the exit code rather than parsing failures.

```json
[{ "input": "...", "output": "...", "style": "oil",
   "width": 3840, "height": 2160, "strokes": 10336, "seconds": 6.8 }]
```

`style` is `"sheet"` for a `--sheet` run, and `width`/`height` are then the
sheet's size rather than the picture's.
