// A style is not a separate renderer. All three run the same stroke engine and
// differ only in the numbers below.
export type Style = {
  bristles: number; // minimum hairs across the brush; wide brushes get more
  alpha: number; // opacity of one bristle pass
  blend: "over" | "multiply";
  jitter: number; // per-bristle colour wobble, 0-255 scale
  mono: boolean; // ink: throw the colour away, tone comes from opacity
  widthFactor: number; // stroke width as a fraction of the brush diameter
  lengthFactor: number; // how far a stroke may travel, as a fraction of the maximum
  paper: [number, number, number] | null; // starting canvas; null = blurred underpainting
  edgeDarken: number; // watercolour pigment pooling at a wash boundary, 0 = off
  substrate: "canvas" | "paper"; // what the medium is worked on
  substrateStrength: number; // how far the tooth shows through the paint
  dryness: number; // how readily a bristle skips over the substrate
  relief: number; // how thickly the paint stands off the surface, 0 = flat
};

export const STYLES: Record<string, Style> = {
  oil: {
    bristles: 7,
    alpha: 0.9,
    blend: "over",
    jitter: 6,
    mono: false,
    widthFactor: 1,
    lengthFactor: 1,
    paper: null,
    edgeDarken: 0,
    substrate: "canvas",
    substrateStrength: 0.1,
    dryness: 0.35,
    relief: 0.4,
  },
  water: {
    bristles: 3,
    alpha: 0.32,
    blend: "over",
    jitter: 3,
    mono: false,
    widthFactor: 1,
    lengthFactor: 1,
    paper: [255, 255, 255],
    edgeDarken: 0.35,
    substrate: "paper",
    substrateStrength: 0.16,
    dryness: 0.5,
    relief: 0, // a wash sinks into the paper, it does not stand off it
  },
  ink: {
    bristles: 1,
    alpha: 0.35,
    blend: "multiply",
    jitter: 0,
    mono: true,
    widthFactor: 0.06, // a nib, not a brush
    lengthFactor: 0.3, // hatching is short marks, not long wandering lines
    paper: [255, 255, 255],
    edgeDarken: 0,
    substrate: "paper",
    substrateStrength: 0.08, // a light tooth; ink is dark on white, so grain reads as speckle
    dryness: 0.32, // a nib skips over paper fibre, but it still has to leave a line
    relief: 0,
  },
};

export type StyleName = keyof typeof STYLES;

export function isStyleName(name: string): name is StyleName {
  return name in STYLES;
}
