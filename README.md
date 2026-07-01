# color-names · over time

**Live:** https://meodai.github.io/color-names-timeline/

A GPU visualization ([cosmos.gl](https://cosmos.gl)) of how the
[color-names](https://github.com/meodai/color-names) dataset grew from **Apr 2017
→ today** — ~34k colors, every one a point tinted with its own hex.

- **Time scrubber / play** — colors fade in (and the rare few out) exactly when
  they were added to the dataset. Freshly-added colors flash brighter and pop
  their name as a label while the timeline plays.
- **Three layouts, animated transitions** — morph the whole cloud between:
  - **RGB cube** — isometric view of RGB space
  - **Hue · Lightness** — hue left→right, light→dark top→bottom
  - **Hue wheel** — angle = hue, radius = saturation
- **Hover** any point for its name + hex.

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
