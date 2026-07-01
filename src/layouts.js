// Color math + the static layouts the points transition between.
// Every layout returns a flat Float32Array [x0,y0,x1,y1,...] in cosmos space
// coordinates (0..SPACE). Positions depend only on a color's RGB/HSL, never on
// time, so we compute each layout once and cache it.

export const SPACE = 4096;
const C = SPACE / 2;

export function hexToRgb01(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  const d = max - min;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

// Deterministic pseudo-random in [-1,1] per point index — small jitter so
// near-identical colors don't stack into a single overplotted pixel.
function jitter(i) {
  const x = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

// linear sRGB -> OKLab [L, a, b].
function linSrgbToOklab(lr, lg, lb) {
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

// sRGB (0..1, gamma) -> OKLab.
function rgbToOklab(r, g, b) {
  return linSrgbToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
}

// CIE 1931 XYZ matching-function approximation (Wyman et al. 2013) — same
// fit meodai's color-palette-shader uses, so the spectrum ordering matches.
const cieX = (w) => {
  const t1 = (w - 442.0) * (w < 442.0 ? 0.0624 : 0.0374);
  const t2 = (w - 599.8) * (w < 599.8 ? 0.0264 : 0.0323);
  const t3 = (w - 501.1) * (w < 501.1 ? 0.049 : 0.0382);
  return 0.362 * Math.exp(-0.5 * t1 * t1) + 1.056 * Math.exp(-0.5 * t2 * t2) - 0.065 * Math.exp(-0.5 * t3 * t3);
};
const cieY = (w) => {
  const t1 = (w - 568.8) * (w < 568.8 ? 0.0213 : 0.0247);
  const t2 = (w - 530.9) * (w < 530.9 ? 0.0613 : 0.0322);
  return 0.821 * Math.exp(-0.5 * t1 * t1) + 0.286 * Math.exp(-0.5 * t2 * t2);
};
const cieZ = (w) => {
  const t1 = (w - 437.0) * (w < 437.0 ? 0.0845 : 0.0278);
  const t2 = (w - 459.0) * (w < 459.0 ? 0.0385 : 0.0725);
  return 1.217 * Math.exp(-0.5 * t1 * t1) + 0.681 * Math.exp(-0.5 * t2 * t2);
};
function wavelengthToOklab(nm) {
  const x = cieX(nm), y = cieY(nm), z = cieZ(nm);
  const lr = Math.max(0, 3.2404542 * x - 1.5371385 * y - 0.4985314 * z);
  const lg = Math.max(0, -0.969266 * x + 1.8760108 * y + 0.041556 * z);
  const lb = Math.max(0, 0.0556434 * x - 0.2040259 * y + 1.0572252 * z);
  return linSrgbToOklab(lr, lg, lb);
}

// Spectral-locus lookup: spectral position sx (0..1) -> OKLab hue angle.
// 0..0.8 walks 410→665nm; 0.8..1.0 is the purple line (red↔violet).
let SPEC = null;
function specTable() {
  if (SPEC) return SPEC;
  const N = 256, hue = new Float32Array(N), sxs = new Float32Array(N);
  const red = wavelengthToOklab(665), violet = wavelengthToOklab(410);
  for (let i = 0; i < N; i++) {
    const sx = i / (N - 1);
    let a, b;
    if (sx < 0.8) { const lab = wavelengthToOklab(410 + (sx / 0.8) * 255); a = lab[1]; b = lab[2]; }
    else { const pt = (sx - 0.8) / 0.2; a = red[1] + (violet[1] - red[1]) * pt; b = red[2] + (violet[2] - red[2]) * pt; }
    hue[i] = Math.atan2(b, a);
    sxs[i] = sx;
  }
  SPEC = { hue, sxs, N };
  return SPEC;
}

// Precompute rgb (0..1), hsl and oklab for every point, plus the base color buffer.
export function computeColorData(points) {
  const n = points.length;
  const rgb = new Float32Array(n * 3);
  const hsl = new Float32Array(n * 3);
  const oklab = new Float32Array(n * 3);
  const colors = new Float32Array(n * 4); // rgba, alpha filled per-frame
  for (let i = 0; i < n; i++) {
    const [r, g, b] = hexToRgb01(points[i].h);
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
    const [h, s, l] = rgbToHsl(r, g, b);
    hsl[i * 3] = h; hsl[i * 3 + 1] = s; hsl[i * 3 + 2] = l;
    const [L, oa, ob] = rgbToOklab(r, g, b);
    oklab[i * 3] = L; oklab[i * 3 + 1] = oa; oklab[i * 3 + 2] = ob;
    colors[i * 4] = r; colors[i * 4 + 1] = g; colors[i * 4 + 2] = b; colors[i * 4 + 3] = 0;
  }
  return { rgb, hsl, oklab, colors };
}

// Default orbit orientation (radians) — a pleasant 3/4 isometric-ish view.
export const DEFAULT_AZ = -0.62;
export const DEFAULT_EL = 0.42;

// Orthographic projection of a 3D point (x, up=y, z) after yaw(az)+pitch(el).
// Returns screen [x, up] in the range the caller scales into space.
function project(x, y, z, ca, sa, ce, se) {
  const x1 = x * ca + z * sa;
  const z1 = -x * sa + z * ca;
  const up = y * ce - z1 * se;
  return [x1, up];
}

// RGB cube. Red/blue on the floor plane, green = up. Orbits with az/el.
function layoutCube(rgb, az = DEFAULT_AZ, el = DEFAULT_EL) {
  const n = rgb.length / 3;
  const p = new Float32Array(n * 2);
  const S = SPACE * 0.4;
  const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
  for (let i = 0; i < n; i++) {
    const [x, up] = project(rgb[i * 3] - 0.5, rgb[i * 3 + 1] - 0.5, rgb[i * 3 + 2] - 0.5, ca, sa, ce, se);
    p[i * 2] = C + x * S + jitter(i) * 6;
    p[i * 2 + 1] = C - up * S + jitter(i + 7) * 6;
  }
  return p;
}

// OKLab solid. Perceptual lightness = up, a/b = the floor plane. Orbits too.
function layoutOklab(oklab, az = DEFAULT_AZ, el = DEFAULT_EL) {
  const n = oklab.length / 3;
  const p = new Float32Array(n * 2);
  const S = SPACE * 0.42, AB = 2.2; // scale a/b (~±0.3) toward the ±0.5 range
  const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
  for (let i = 0; i < n; i++) {
    const [x, up] = project(oklab[i * 3 + 1] * AB, oklab[i * 3] - 0.5, oklab[i * 3 + 2] * AB, ca, sa, ce, se);
    p[i * 2] = C + x * S + jitter(i) * 6;
    p[i * 2 + 1] = C - up * S + jitter(i + 7) * 6;
  }
  return p;
}

// Hue across X, lightness down Y. Near-greys go to a gutter on the left.
function layoutHueLight(hsl) {
  const n = hsl.length / 3;
  const p = new Float32Array(n * 2);
  const m = SPACE * 0.07, w = SPACE - 2 * m, h = SPACE - 2 * m;
  for (let i = 0; i < n; i++) {
    const hue = hsl[i * 3], s = hsl[i * 3 + 1], l = hsl[i * 3 + 2];
    let x;
    if (s < 0.06) x = m * 0.25 + (jitter(i) * 0.5 + 0.5) * m * 0.5; // grey gutter
    else x = m + (hue / 360) * w + jitter(i) * 8;
    const y = m + (1 - l) * h + jitter(i + 3) * 8;
    p[i * 2] = x; p[i * 2 + 1] = y;
  }
  return p;
}

// Spectrum: X follows the physical spectral locus (violet→red→purple line) by
// matching each color's OKLab hue to a wavelength; Y = perceptual lightness.
function layoutSpectrum(oklab) {
  const t = specTable();
  const n = oklab.length / 3;
  const p = new Float32Array(n * 2);
  const m = SPACE * 0.07, w = SPACE - 2 * m, h = SPACE - 2 * m;
  for (let i = 0; i < n; i++) {
    const L = oklab[i * 3], a = oklab[i * 3 + 1], b = oklab[i * 3 + 2];
    let x;
    if (Math.hypot(a, b) < 0.04) {
      x = m * 0.25 + (jitter(i) * 0.5 + 0.5) * m * 0.5; // neutral gutter
    } else {
      const H = Math.atan2(b, a);
      let best = 0, bd = 1e9;
      for (let k = 0; k < t.N; k++) {
        let d = Math.abs(H - t.hue[k]);
        if (d > Math.PI) d = 2 * Math.PI - d;
        if (d < bd) { bd = d; best = k; }
      }
      x = m + t.sxs[best] * w + jitter(i) * 6;
    }
    p[i * 2] = x;
    p[i * 2 + 1] = m + (1 - L) * h + jitter(i + 3) * 6;
  }
  return p;
}

// Polar colour wheel: angle = hue, radius = saturation. Greys collapse to center.
function layoutWheel(hsl) {
  const n = hsl.length / 3;
  const p = new Float32Array(n * 2);
  const R = SPACE * 0.45;
  for (let i = 0; i < n; i++) {
    const a = hsl[i * 3] * Math.PI / 180, s = hsl[i * 3 + 1];
    const rad = s * R;
    p[i * 2] = C + Math.cos(a) * rad + jitter(i) * 5;
    p[i * 2 + 1] = C + Math.sin(a) * rad + jitter(i + 1) * 5;
  }
  return p;
}

export const LAYOUTS = [
  { id: 'cube', label: 'RGB cube', orbit: true, hint: 'red · blue on the floor, green ↑ · drag the circle to rotate', build: (d, az, el) => layoutCube(d.rgb, az, el) },
  { id: 'oklab', label: 'OKLab', orbit: true, hint: 'perceptual lightness ↑ · a (green–red) / b (blue–yellow) floor · drag to rotate', build: (d, az, el) => layoutOklab(d.oklab, az, el) },
  { id: 'huelight', label: 'Hue · Lightness', hint: 'hue → left-to-right · light → top, dark → bottom · greys parked left', build: (d) => layoutHueLight(d.hsl) },
  { id: 'spectrum', label: 'Spectrum', hint: 'spectral wavelength → left-to-right (violet→red→purple line) · perceptual lightness ↑', build: (d) => layoutSpectrum(d.oklab) },
  { id: 'wheel', label: 'Hue wheel', hint: 'angle = hue · radius = saturation · greys at center', build: (d) => layoutWheel(d.hsl) },
];
