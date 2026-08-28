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

**Brush size is relative to image width.** The widest brush is `width / 30` and
the ladder halves down from there, by default through four halvings to
`width / 240`. A 1080p and a 6K copy of the same photo therefore come out looking
like the same painting at two print sizes, which matters when a wallpaper pool
mixes resolutions. `--brush` moves the whole ladder, so it sets the character;
`--detail` extends the bottom of it, so it sets how much of the original picture
survives.

**How far down the ladder goes is the single thing that decides detail.** The
first version stopped at `width / 120`, a 32px brush at 4K, and quietly erased
everything smaller than that: a fire tower on a ridge, the legs of a horse. Three
extra halvings brought them back without touching the wide end, so the blocking-in
still reads as paint. Past about `--detail 2` the result stops looking painted and
starts looking like a slightly soft photograph.

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

**Three artefacts were fixed by making the marks behave like real ones**, and
each is worth keeping in mind before changing that code:

- *Bristle jitter is tonal, not chromatic.* Jittering each colour channel
  independently shifts the hue, which paints rainbow streaks across a smooth sky.
  One shared shift across all three channels reads as a bristle carrying more or
  less paint, which is what actually varies.
- *The gradient is sampled at brush width, not per pixel.* A wide brush in a
  smooth sky sees nothing one pixel away, so a one-pixel Sobel returns rounding
  noise and the strokes fan out into a starburst around any high-contrast
  subject.
- *Every stroke leans a few degrees off its heading.* Strokes seeded on a regular
  grid and pointing the same way band into scan lines, most visibly in ink.

**Texture is three passes behind one `--texture` knob** (0 to 1, default 1):

- *Substrate.* A procedural linen weave under oil, cold-press paper under water
  and ink. Generated as a wrapped 1024px tile rather than per pixel, because
  several octaves of noise across 28 million pixels would cost more than the
  painting does. The weave is mostly fibre noise with a faint warp and weft
  through it: two sines alone peak at every crossing and read as a regular dot
  screen rather than cloth. Masked by paint thickness, so it shows through thin paint and
  is buried under thick.
- *Dry brush.* A bristle carries a finite load. As it runs out it stops bridging
  the pits in the substrate and catches only the raised fibre, so marks break up
  and end ragged rather than square.
- *Relief.* A height field accumulated from every dab, softened, then lit from
  the upper left so thick paint stands off the surface. Oil only; a wash sinks
  into paper rather than standing on it.

Two constants in there are load-bearing. **Thickness is capped at one**: a
second coat of oil sits a little proud of the first, a tenth does not sit ten
times proud, and uncapped it saturates the relief into embossed plaster.
**The relief lighting uses only the directional term**, not the straight-on one,
or every sloped pixel comes out darker than flat paint and the whole picture
sinks.

**The reference blur is 0.3 of the brush radius, not the paper's 0.5.** At this
tool's brush sizes 0.5 smears a bright region well into a neighbouring dark one,
and the coarse layer then paints that invented colour as a halo around any
high-contrast subject. Relief makes such a halo far more visible, which is how
it was found.

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

**Every sheet cell carries a 3x detail inset.** A sheet is far wider than any
window, so it is looked at scaled down, and scaling is exactly what destroys
canvas weave and stroke relief: the first textured sheets looked untextured. The
inset is magnified by the same factor the sheet is typically shrunk by, so it
lands back at roughly one to one. Its crop is chosen from a calm part of the
picture rather than the busiest, because the full cell already shows the
brushwork and what an inset is for is the surface.

## Known limitation

A faint halo of pale slabs can appear in flat areas next to a high-contrast
subject, most visibly around a dark shape against a bright sky. The coarsest
layer's blurred reference mixes the bright region into the dark one, and the
layer paints that mixture as real. Sharpening the reference blur and lowering
`--brush` both reduce it; neither removes it. A stroke-level fix was tried
(terminate a stroke once the true source colour strays from the colour it is
carrying) and reverted: the offending strokes are close to the sky's own colour,
so the test does not catch them.

## Not doing

- A GUI, a web version, or live preview.
- Video.
- Bundled paper textures or brush-tip PNGs. The substrate is generated, so the
  look travels with the code and scales to any resolution.

## Distribution

Ships on npm, run with `bunx brushwork` or installed with `bun install -g
brushwork`. Not a compiled binary: sharp is a native NAPI addon and
`bun build --compile` bundles it but cannot load it at runtime
(`Could not load the "sharp" module using the darwin-arm64 runtime`). Verified on
Bun 1.3.10.

## Performance

3840x2160 oil render: 6.8s, on the M3 Pro, texture included. `--preview` renders at
1200px wide in well under a second, which is what `--sheet` uses for its six
cells.
