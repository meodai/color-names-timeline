# color-names · over time

**Live:** https://meodai.github.io/color-names-timeline/

A GPU visualization ([cosmos.gl](https://cosmos.gl)) of how the
[color-names](https://github.com/meodai/color-names) dataset grew from **Apr 2017
→ today** — ~34k colors, every one a point tinted with its own hex.

- **Time scrubber / play** — colors fade in (and the rare few out) exactly when
  they were added to the dataset. Freshly-added colors flash brighter, pop their
  name, and briefly link up as a small network with the other colors from the
  same commit. Removed colors swell and vanish.
- **Five color models, animated transitions** — morph the whole cloud between:
  - **RGB cube** — isometric view of RGB space
  - **OKLab** — perceptual lightness up, a/b on the floor plane
  - **Hue · Lightness** — hue left→right, light→dark top→bottom
  - **Spectrum** — colors placed by their CIE spectral wavelength
  - **Hue wheel** — angle = hue, radius = saturation
- **Globe** — drag the little sphere to rotate the 3D layouts (RGB cube / OKLab).
- **Hover** any point for its name, hex, and the commit that introduced it.

## A note on time

The dataset didn't actually start on GitHub. It began life as a **Google
Spreadsheet** created on **10 Aug 2016**, and only became a git repository with
the [initial commit](https://github.com/meodai/color-names/commit/6f4fdcc) on
**23 Apr 2017**. This timeline therefore starts in April 2017, because that's as
far back as the per-commit add/remove history reaches — the ~8 months of
pre-GitHub collecting in the spreadsheet aren't represented (yet). Folding that
earlier Google-Sheets history into the timeline is an open **TODO**; the sheet's
own revision history is the most likely source, if it can be exported in a form
that maps colors to dates.

## Data

The time axis comes straight from the project's own history JSON (the output of
`npm run history` in the parent repo → `dist/history.json`), which lists the
colors added / removed / changed in every commit. `build-data.js` compacts that
into a per-color birth/death timeline (`public/colors.json`); positions are
derived from each color's RGB, so time only controls visibility.

## Run

```bash
npm install
npm run data     # regenerate public/colors.json from ../dist/history.json
npm run dev
```

`npm run data` reads `../dist/history.json` if present (regenerate it with
`npm run history` in the parent repo), otherwise a local `history.raw.json`.
The generated `public/colors.json` is committed, so deploys don't need the
parent repo — CI just runs `vite build`.

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds with
Vite and publishes `dist/` to GitHub Pages.
