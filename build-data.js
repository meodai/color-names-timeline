// Compacts the color-names project's canonical history JSON into a per-color
// timeline for the viz.
//
// Input is the exact output of the repo's own `npm run history` script
// (../dist/history.json): one entry per commit with {date, added, removed,
// changed}. We DON'T re-derive it from git — we reuse the JSON the project
// already produces. Regenerate the source with `npm run data`.
//
// Each unique hex becomes ONE point. Its position in every layout is derived
// from its RGB value (static), so "time" only controls whether the point is
// alive. We record a birth day-index and (if it was later removed and not
// re-added) a death day-index, measured in whole days from the project start.
//
// Output: public/colors.json  { start, dayMs, days, points:[{h,n,b,d}] }
//   h = hex, n = latest name, b = birth day-index, d = death day-index|null

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = 'https://github.com/meodai/color-names';
const DAY = 86400000;

// Pre-GitHub origin: the launch set was assembled in a Google Sheet starting
// 2016-08-10, months before GitHub. The sheet was NOT grown incrementally, so
// there is no real per-color pre-git date — we spread the launch colors back
// across the window as synthetic, clearly-flagged batches of varying size so
// the origin is visible in the viz. See
// docs/superpowers/specs/2026-07-01-pregit-origin-viz-design.md.
const PREGIT_FOUNDED = '2016-08-10T02:24:00+02:00';
const PREGIT_BATCHES = 24;
const PREGIT_SEED = 20160810;
// The canonical colors any list would start with — floated to the very front of
// the origin era, in this fundamental order, ahead of the length-scored rest.
const CANONICAL_ORDER = [
  'black', 'white', 'gray', 'grey', 'red', 'green', 'blue', 'yellow', 'cyan',
  'magenta', 'orange', 'purple', 'pink', 'brown', 'violet', 'indigo', 'teal',
  'maroon', 'navy', 'olive', 'lime', 'gold', 'silver', 'turquoise', 'beige',
  'tan', 'lavender', 'crimson', 'scarlet', 'azure', 'ivory', 'coral', 'salmon',
  'khaki', 'plum', 'orchid', 'mint', 'peach', 'mustard', 'rose',
];
const CANONICAL = new Map(CANONICAL_ORDER.map((n, i) => [n, i]));

// Prefer the canonical artifact the project generates; fall back to a local dump.
const canonical = new URL('../dist/history.json', import.meta.url);
const local = new URL('./history.raw.json', import.meta.url);
const source = existsSync(canonical) ? canonical : local;
const raw = JSON.parse(readFileSync(source));

// history.raw.json is newest-first (git log order) -> walk chronologically.
const commitsChrono = raw.slice().reverse();

// Spread the launch set back across a synthetic pre-GitHub era (2016-08-10 ->
// git launch) as flagged batches of varying size, so the origin is visible.
injectPreGitOrigin(commitsChrono);

// The history JSON has no commit hashes, so pull hash<->date from the parent
// repo's git log (same %ci format the history script uses) and match by date.
const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const hashByDate = new Map();
try {
  const log = execSync(
    'git log --no-merges --follow --pretty=format:%H%x09%h%x09%ci%x09%s -- ./src/colornames.csv',
    { cwd: repoDir, maxBuffer: 1024 * 1024 * 100 },
  ).toString().trim().split('\n');
  for (const line of log) {
    const [H, h, ci, ...rest] = line.split('\t');
    hashByDate.set(ci, { H, h, s: rest.join('\t') });
  }
} catch (e) {
  console.warn('could not read git hashes:', e.message);
}

const startMs = new Date(commitsChrono[0].date).getTime();
const dayIndex = (dateStr) => Math.round((new Date(dateStr).getTime() - startMs) / DAY);

// One entry per commit that changed the dataset: day-index + short/full hash.
const commits = commitsChrono.map((c) => {
  const hash = hashByDate.get(c.date) || { H: '', h: '', s: '' };
  const entry = { d: dayIndex(c.date), h: hash.h, H: hash.H, m: hash.s || '', a: c.added.length, r: c.removed.length };
  if (c.pregit) { entry.g = 1; entry.m = 'pre-GitHub batch · Google Sheet'; }
  return entry;
});

/** @type {Map<string,{n:string,b:number,d:number|null,c:number}>} */
const points = new Map();

commitsChrono.forEach((commit, ci) => {
  const day = dayIndex(commit.date);

  for (const { hex } of commit.removed) {
    const key = norm(hex);
    if (key && points.has(key)) points.get(key).d = day;
  }
  for (const { hex, name } of commit.changed) {
    const key = norm(hex);
    if (!key) continue;
    if (points.has(key)) points.get(key).n = name; // rename, keep birth
    else points.set(key, { n: name, b: day, d: null, c: ci });
  }
  for (const { hex, name } of commit.added) {
    const key = norm(hex);
    if (!key) continue;
    const existing = points.get(key);
    if (existing) { existing.d = null; existing.n = name; } // re-added -> alive again
    else points.set(key, { n: name, b: day, d: null, c: ci });
  }
});

// --- pre-GitHub origin synthesis -----------------------------------
// Turn the first git commit's additions (the launch set) into a run of
// synthetic pre-git batches spread across 2016-08-10 -> git launch. Batch
// sizes vary; color->batch assignment is a seeded shuffle. Flagged `pregit`.
function injectPreGitOrigin(chrono) {
  const first = chrono[0];
  if (!first || !first.added.length) return;
  const launch = first.added.slice(); // the founding colors (first git commit)
  first.added = [];                   // reborn pre-git; the GitHub import adds nothing new

  const FOUND = new Date(PREGIT_FOUNDED).getTime();
  const gitMs = new Date(first.date).getTime();
  const spanMs = gitMs - FOUND - DAY; // stop a day short of the git launch
  const rng = mulberry32(PREGIT_SEED);

  const N = PREGIT_BATCHES;
  // squared-ish weights -> a few big batches, many small ones
  const w = Array.from({ length: N }, () => 0.12 + rng() * rng());
  const wsum = w.reduce((a, b) => a + b, 0);
  const sizes = w.map((x) => Math.max(1, Math.round((x / wsum) * launch.length)));
  let drift = launch.length - sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; drift !== 0; i = (i + 1) % N) {
    const s = Math.sign(drift);
    if (sizes[i] + s >= 1) { sizes[i] += s; drift -= s; }
  }

  // Order by name simplicity (plus jitter) so the origin era reveals the plain,
  // canonical names first and the long/fancy ones drift in later — a pure random
  // assignment made the first batches feel wrong.
  const ordered = launch
    .map((c) => {
      const rank = CANONICAL.get(c.name.toLowerCase());
      const k = rank !== undefined ? -1000 + rank : nameComplexity(c.name) + (rng() - 0.5) * 12;
      return { c, k };
    })
    .sort((a, b) => a.k - b.k)
    .map((x) => x.c);

  // Batch dates: stratified + jittered across the window, sorted ascending so the
  // simplest slice lands on the earliest date (first pinned to the founding day).
  const days = [];
  for (let i = 0; i < N; i++) days.push(FOUND + (i === 0 ? 0 : (i + rng()) / N) * spanMs);
  days.sort((a, b) => a - b);

  const batches = [];
  let cursor = 0;
  for (let i = 0; i < N; i++) {
    const added = ordered.slice(cursor, cursor + sizes[i]);
    cursor += sizes[i];
    if (added.length) batches.push({ date: new Date(days[i]).toISOString(), added, removed: [], changed: [], pregit: true });
  }
  chrono.unshift(...batches);
}

// Small seeded PRNG so every `npm run data` rebuild is byte-identical.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Lower = plainer name. Single common words score lowest; extra words, length,
// digits and punctuation (e.g. "18th Century Green", "À l'Orange") push later.
function nameComplexity(name) {
  const words = name.trim().split(/\s+/).length;
  const hasDigit = /\d/.test(name) ? 1 : 0;
  const hasPunct = /[^A-Za-z\s]/.test(name) ? 1 : 0;
  return words * 10 + name.length + hasDigit * 16 + hasPunct * 8;
}

function norm(hex) {
  if (!hex) return null;
  let h = hex.trim().toLowerCase();
  if (!h.startsWith('#')) h = '#' + h;
  return /^#[0-9a-f]{6}$/.test(h) ? h : null;
}

const days = dayIndex(commitsChrono[commitsChrono.length - 1].date);
const out = {
  start: commitsChrono[0].date,
  dayMs: DAY,
  days,
  repo: REPO,
  commits,
  points: [...points.entries()].map(([h, p]) => ({ h, n: p.n, b: p.b, d: p.d, c: p.c })),
};

mkdirSync(new URL('./public/', import.meta.url), { recursive: true });
writeFileSync(new URL('./public/colors.json', import.meta.url), JSON.stringify(out));

const alive = out.points.filter((p) => p.d === null).length;
console.log(`points: ${out.points.length}  alive today: ${alive}  span: ${days} days`);
console.log(`start: ${out.start}  size: ${(JSON.stringify(out).length / 1e6).toFixed(2)} MB`);
