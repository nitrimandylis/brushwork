# brushwork

A command-line tool that repaints a photograph as a painting made of visible
brush strokes. Built for wallpapers: point it at an image, get back the same
image as oil, watercolour or pen and ink at the same resolution.

## What it is

```
brushwork tower.jpg --style oil --brush 1.4
brushwork tower.jpg --sheet
brushwork ~/wall/*.jpg --style ink -o painted/
```

Plain file in, file out. It knows nothing about [swatch](https://github.com/nitrimandylis/swatch);
paint a wallpaper, then `swatch add` the result yourself.

## Decisions

**Stroke placement is Hertzmann's layered algorithm** (*Painterly Rendering with
Curved Brush Strokes of Multiple Sizes*, 1998). Three coarse-to-fine passes. Each
pass compares the canvas against a blurred reference and seeds a stroke only in
grid cells the canvas currently gets wrong, so flat sky earns a handful of broad
strokes and a treeline earns hundreds of fine ones. Strokes run perpendicular to
the luminance gradient and re-steer at every step, which is why the paint appears
to follow the form of what it is painting.

**A stroke is a bristle brush, not a line.** Five to twenty-four thin parallel
paths, offset sideways, each carrying slightly jittered colour and opacity. Flat
polylines read as felt-tip marker; the streaking within a stroke is what makes it
read as paint.

**Brush size is relative to image width**, `width / 120` for the finest layer and
4x/2x/1x above it. A 1080p and a 6K copy of the same photo therefore come out
looking like the same painting at two print sizes, which matters when a wallpaper
pool mixes resolutions. `--brush` multiplies the whole ladder.

**One engine, three styles.** `oil`, `water` and `ink` are not separate
renderers, they are configuration: bristle count, opacity, blend mode, colour
jitter, starting canvas, post-pass. Adding a fourth style is a dict entry.

**Oil starts from a blurred underpainting**, the other two start from white
paper. Without an underpainting the first coarse pass has to cover the entire
frame at full stroke length, which costs roughly thirty times more paint than the
picture needs.

**The source is mirror-padded before painting and cropped afterwards.** Strokes
can then be seeded outside the frame and paint across the real edge. Without it
the outer band of every render is measurably thinner than the rest of the
picture.

**PNG out, with the source ICC profile attached.** Stroke edges are high
frequency and JPEG rings on them; `--jpeg` is there when file size matters more.
The profile is carried across verbatim so a P3 wallpaper does not come back
washed out.

## Rejected

- **Neural style transfer.** Considered as a fourth `--style`, dropped before any
  code: 800MB of torch and weights, a slow path, and a result with two knobs that
  cannot be explained line by line.
- **Knowing about swatch.** A `--theme firewatch` mode would have hardcoded
  swatch's config layout and been useless to anyone else.
- **Multiply blending for watercolour.** It is the intuitive operator and it is
  wrong: repeated washes of the same target colour compound towards black rather
  than converging on the colour. Watercolour uses low-alpha `over` plus edge
  darkening instead.

## Not doing

- A GUI, a web version, or live preview.
- Video.
- Paper texture assets or brush-tip PNGs. The look is generated, not bundled.

## Distribution

Ships on npm, run with `bunx brushwork` or installed with `bun install -g
brushwork`. Not a compiled binary: sharp is a native NAPI addon and
`bun build --compile` bundles it but cannot load it at runtime
(`Could not load the "sharp" module using the darwin-arm64 runtime`). Verified on
Bun 1.3.10.

## Performance

3840x2160 oil render: 5.0s, 3.4MB PNG, on the M3 Pro. `--preview` renders at
1200px wide in well under a second, which is what `--sheet` uses for its six
cells.
