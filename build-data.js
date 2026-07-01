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

// Prefer the canonical artifact the project generates; fall back to a local dump.
const canonical = new URL('../dist/history.json', import.meta.url);
const local = new URL('./history.raw.json', import.meta.url);
const source = existsSync(canonical) ? canonical : local;
const raw = JSON.parse(readFileSync(source));

// history.raw.json is newest-first (git log order) -> walk chronologically.
const commitsChrono = raw.slice().reverse();

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
const DAY = 86400000;
const dayIndex = (dateStr) => Math.round((new Date(dateStr).getTime() - startMs) / DAY);

// One entry per commit that changed the dataset: day-index + short/full hash.
const commits = commitsChrono.map((c) => {
  const hash = hashByDate.get(c.date) || { H: '', h: '', s: '' };
  return { d: dayIndex(c.date), h: hash.h, H: hash.H, m: hash.s || '', a: c.added.length, r: c.removed.length };
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
