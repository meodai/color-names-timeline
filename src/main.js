import { Graph } from '@cosmos.gl/graph';
import { SPACE, LAYOUTS, computeColorData, DEFAULT_AZ, DEFAULT_EL } from './layouts.js';
import './style.css';

const RECENT_DAYS = 45;      // how long a color stays "freshly added" (highlight)
const DEATH_DAYS = 45;       // how long a removed color lingers while swelling out
const BASE_SIZE = 2.6;
const HL_SIZE = 9;
const ALIVE_ALPHA = 0.82;
const PLAY_SECONDS = 42;     // full-history playback duration
const TRANSITION_MS = 1100;  // layout morph duration
const MAX_LABELS = 10;
const LABEL_LIFE = 1900;

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

boot();

async function boot() {
  const data = await fetch('colors.json').then((r) => r.json());
  const points = data.points;
  const commits = data.commits;
  const repo = data.repo;
  const n = points.length;
  const startMs = new Date(data.start).getTime();
  const dayMs = data.dayMs;
  const totalDays = data.days;

  // Last commit at-or-before a given day (commits are chronological).
  const commitAt = (day) => {
    let lo = 0, hi = commits.length - 1, res = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (commits[mid].d <= day) { res = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return commits[res];
  };

  // Flat typed arrays for the hot loop.
  const births = new Float32Array(n);
  const deaths = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    births[i] = points[i].b;
    deaths[i] = points[i].d === null ? Infinity : points[i].d;
  }

  const { rgb, hsl, oklab, colors } = computeColorData(points);
  const colorData = { rgb, hsl, oklab };

  // Declared early: the orbit-able layout builders read state.az / state.el.
  const state = { day: totalDays, prevDay: totalDays, layout: 'cube', playing: false, az: DEFAULT_AZ, el: DEFAULT_EL };

  const layoutCache = new Map();
  const buildLayout = (id) => {
    const L = LAYOUTS.find((l) => l.id === id);
    if (L.orbit) return L.build(colorData, state.az, state.el); // rotation-dependent, don't cache
    if (!layoutCache.has(id)) layoutCache.set(id, L.build(colorData));
    return layoutCache.get(id);
  };

  const sizes = new Float32Array(n);
  let curPos = Float32Array.from(buildLayout('cube')); // live on-screen positions

  // --- graph ---------------------------------------------------------
  const graph = new Graph($('#graph'), {
    backgroundColor: '#000000',
    spaceSize: SPACE,
    enableSimulation: false,
    rescalePositions: false,
    fitViewOnInit: true,
    fitViewPadding: 0.18,
    enableDrag: false,
    enableZoom: true,
    pointDefaultSize: BASE_SIZE,
    renderLinks: true,
    linkDefaultWidth: 1.5,
    linkWidthScale: 1,
    linkDefaultColor: [1, 1, 1, 0.85],
    curvedLinks: true,
    curvedLinkControlPointDistance: 0.4,
    hoveredPointCursor: 'pointer',
    onPointMouseOver: (index) => showTooltip(index),
    onPointMouseOut: () => hideTooltip(),
    onPointClick: (index) => showTooltip(index, true),
  });

  graph.setPointPositions(curPos, true);
  graph.setPointColors(colors);
  graph.setPointSizes(sizes);
  graph.render(0);

  const hasS2S = typeof graph.spaceToScreenPosition === 'function';

  const trans = { active: false, from: null, to: null, start: 0 };
  const labels = []; // {i, born, el}
  const fresh = []; // indices of freshly-added points this refresh
  let lastEmit = 0;

  const scrub = $('#scrub');
  scrub.max = String(totalDays);
  scrub.value = String(totalDays);

  // --- time / appearance ---------------------------------------------
  function refreshBuffers(emit) {
    const day = state.day;
    let alive = 0;
    const canEmit = emit && state.playing && labels.length < MAX_LABELS;
    let emitted = 0;
    fresh.length = 0;
    for (let i = 0; i < n; i++) {
      const b = births[i];
      const isAlive = day >= b && day < deaths[i];
      const a = i * 4;
      if (isAlive) {
        alive++;
        const age = day - b;
        if (age < RECENT_DAYS) {
          const k = age / RECENT_DAYS;
          colors[a + 3] = 1;
          sizes[i] = HL_SIZE + (BASE_SIZE - HL_SIZE) * k;
          fresh.push(i); // freshly-added -> eligible for temporary same-commit links
          // spotlight colors born in the step we just crossed
          if (canEmit && emitted < 3 && b > state.prevDay && b <= day) {
            spawnLabel(i);
            emitted++;
          }
        } else {
          colors[a + 3] = ALIVE_ALPHA;
          sizes[i] = BASE_SIZE;
        }
      } else {
        const dd = deaths[i];
        const sinceDeath = dd === Infinity ? Infinity : day - dd;
        if (sinceDeath >= 0 && sinceDeath < DEATH_DAYS) {
          // removed: swell then vanish — the mirror of the birth pop
          const k = sinceDeath / DEATH_DAYS;
          colors[a + 3] = ALIVE_ALPHA * (1 - k);
          sizes[i] = BASE_SIZE + (HL_SIZE * 1.5 - BASE_SIZE) * k;
        } else {
          colors[a + 3] = 0;
          sizes[i] = 0;
        }
      }
    }
    graph.setPointColors(colors);
    graph.setPointSizes(sizes);
    updateLinks();
    updateReadout(day, alive);
  }

  // Temporary network between freshly-added colors that share a birth commit:
  // each color links to its 2 nearest siblings in OKLab, forming a mesh rather
  // than a star. Rebuilt every refresh; empty when nothing is fresh.
  const linkGroups = new Map();
  const okDist = (p, q) => {
    const dL = oklab[p * 3] - oklab[q * 3], da = oklab[p * 3 + 1] - oklab[q * 3 + 1], db = oklab[p * 3 + 2] - oklab[q * 3 + 2];
    return dL * dL + da * da + db * db;
  };
  const hueOf = (p) => Math.atan2(oklab[p * 3 + 2], oklab[p * 3 + 1]);

  function updateLinks() {
    linkGroups.clear();
    for (const i of fresh) {
      const c = points[i].c;
      let g = linkGroups.get(c);
      if (!g) { g = []; linkGroups.set(c, g); }
      g.push(i);
    }
    const link = [], lcol = [], seen = new Set();
    const addEdge = (u, v) => {
      const key = u < v ? u * 100000 + v : v * 100000 + u;
      if (seen.has(key)) return;
      seen.add(key);
      link.push(u, v);
      lcol.push(rgb[v * 3], rgb[v * 3 + 1], rgb[v * 3 + 2], 0.85); // tint by an endpoint color
    };
    for (const g of linkGroups.values()) {
      const L = g.length;
      if (L < 2) continue;
      if (L <= 80) {
        for (let ai = 0; ai < L; ai++) {
          const p = g[ai];
          let n1 = -1, n2 = -1, d1 = Infinity, d2 = Infinity;
          for (let bi = 0; bi < L; bi++) {
            if (bi === ai) continue;
            const dd = okDist(p, g[bi]);
            if (dd < d1) { d2 = d1; n2 = n1; d1 = dd; n1 = g[bi]; }
            else if (dd < d2) { d2 = dd; n2 = g[bi]; }
          }
          if (n1 >= 0) addEdge(p, n1);
          if (n2 >= 0) addEdge(p, n2);
        }
      } else {
        // huge bulk commit: thread by hue to keep it cheap and legible
        const sorted = g.slice().sort((x, y) => hueOf(x) - hueOf(y));
        for (let j = 1; j < sorted.length; j++) addEdge(sorted[j - 1], sorted[j]);
      }
    }
    graph.setLinks(new Float32Array(link));
    graph.setLinkColors(new Float32Array(lcol));
  }

  const commitLink = $('#commit');
  const hintEl = $('#hint');
  function updateReadout(day, alive) {
    const d = new Date(startMs + day * dayMs);
    $('#date').textContent = d.toLocaleString('en', { month: 'short', year: 'numeric' });
    $('#count').textContent = alive.toLocaleString('en') + ' colors';
    const c = commitAt(day);
    if (c && c.h) {
      commitLink.textContent = c.h;
      commitLink.href = `${repo}/commit/${c.H}`;
      commitLink.style.visibility = 'visible';
    } else {
      commitLink.style.visibility = 'hidden';
    }
    hintEl.textContent = c && c.m ? c.m : '';
    scrub.value = String(Math.round(day));
  }

  // Commit rug (a faint 1px mark per commit) + year ticks.
  (function buildTicks() {
    const ticks = $('#ticks');
    // Height scales with colors added (sqrt-compressed — some commits add 1000s).
    const maxA = Math.sqrt(Math.max(1, ...commits.map((c) => c.a || 0)));
    for (const c of commits) {
      const el = document.createElement('div');
      el.className = c.g ? 'ctick pregit' : 'ctick';
      el.style.left = (c.d / totalDays) * 100 + '%';
      el.style.height = (5 + (Math.sqrt(c.a || 0) / maxA) * 23).toFixed(1) + 'px';
      ticks.appendChild(el);
    }
    const endY = new Date(startMs + totalDays * dayMs).getFullYear();
    for (let y = new Date(startMs).getFullYear() + 1; y <= endY; y++) {
      const day = (new Date(y, 0, 1).getTime() - startMs) / dayMs;
      if (day < 0 || day > totalDays) continue;
      const el = document.createElement('div');
      el.className = 'tick';
      el.style.left = (day / totalDays) * 100 + '%';
      el.innerHTML = `<span>'${String(y).slice(2)}</span>`;
      ticks.appendChild(el);
    }
  })();

  // --- floating name labels ------------------------------------------
  function spawnLabel(i) {
    const el = document.createElement('div');
    el.className = 'plabel';
    el.innerHTML = `<span class="dot" style="background:${points[i].h}"></span>${points[i].n}`;
    $('#labels').appendChild(el);
    labels.push({ i, born: performance.now(), el });
  }

  function updateLabels(now) {
    if (!labels.length || !hasS2S) return;
    for (let k = labels.length - 1; k >= 0; k--) {
      const L = labels[k];
      const t = (now - L.born) / LABEL_LIFE;
      if (t >= 1) { L.el.remove(); labels.splice(k, 1); continue; }
      const s = graph.spaceToScreenPosition([curPos[L.i * 2], curPos[L.i * 2 + 1]]);
      if (!s) continue;
      const fade = t < 0.15 ? t / 0.15 : t > 0.7 ? (1 - t) / 0.3 : 1;
      L.el.style.left = s[0] + 'px';
      L.el.style.top = s[1] + 'px';
      L.el.style.opacity = clamp(fade, 0, 1);
    }
  }

  function clearLabels() {
    labels.forEach((L) => L.el.remove());
    labels.length = 0;
  }

  // --- layout transitions --------------------------------------------
  function goLayout(id) {
    if (id === state.layout && !trans.active) return;
    state.layout = id;
    modelSelect.value = id;
    const L = LAYOUTS.find((l) => l.id === id);
    orbitEl.classList.toggle('hidden', !L.orbit);
    trans.from = Float32Array.from(curPos);
    trans.to = buildLayout(id);
    trans.start = performance.now();
    trans.active = true;
  }

  // --- main loop -----------------------------------------------------
  let last = performance.now();
  const daysPerMs = totalDays / (PLAY_SECONDS * 1000);

  function frame(now) {
    const dt = now - last;
    last = now;
    let dirtyTime = false;

    if (state.playing) {
      state.day = clamp(state.day + dt * daysPerMs, 0, totalDays);
      dirtyTime = true;
      if (state.day >= totalDays) { state.playing = false; updatePlayBtn(); }
    }

    if (trans.active) {
      const t = clamp((now - trans.start) / TRANSITION_MS, 0, 1);
      const e = easeInOut(t);
      const from = trans.from, to = trans.to;
      for (let j = 0; j < curPos.length; j++) curPos[j] = from[j] + (to[j] - from[j]) * e;
      graph.setPointPositions(curPos, true);
      if (t >= 1) trans.active = false;
    }

    if (dirtyTime) {
      refreshBuffers(now - lastEmit > 90);
      if (now - lastEmit > 90) lastEmit = now;
      state.prevDay = state.day;
    }

    if (dirtyTime || trans.active) graph.render(0);
    updateLabels(now);
    requestAnimationFrame(frame);
  }

  // --- controls ------------------------------------------------------
  function seek(day) {
    state.day = clamp(day, 0, totalDays);
    state.prevDay = state.day;
    clearLabels();
    refreshBuffers(false);
    graph.render(0);
  }

  scrub.addEventListener('input', () => {
    if (state.playing) { state.playing = false; updatePlayBtn(); }
    seek(Number(scrub.value));
  });

  function updatePlayBtn() { $('#play').textContent = state.playing ? '❚❚' : '▶'; }

  $('#play').addEventListener('click', () => {
    if (!state.playing && state.day >= totalDays) seek(0); // restart from the beginning
    state.playing = !state.playing;
    updatePlayBtn();
    last = performance.now();
  });

  // layout dropdown
  const modelSelect = $('#model-select');
  LAYOUTS.forEach((l) => {
    const o = document.createElement('option');
    o.value = l.id;
    o.textContent = l.label;
    modelSelect.appendChild(o);
  });
  modelSelect.value = state.layout;
  modelSelect.addEventListener('change', () => goLayout(modelSelect.value));

  // --- orbit trackball (rotates the 3D layouts) ----------------------
  // Rendered as a tilted orthographic globe: a meridian (longitude) and a
  // parallel (latitude) crossing at the dot, front halves bright / back dim.
  const orbitEl = $('#orbit');
  const orbitDot = $('#orbit-dot');
  const arcMF = $('#arc-mf'), arcMB = $('#arc-mb'), arcPF = $('#arc-pf'), arcPB = $('#arc-pb');
  const EL_MAX = (Math.PI / 2) * 0.92;
  const SPH_R = 44, SPH_C = 50, TILT = 0.34;
  const CB = Math.cos(TILT), SB = Math.sin(TILT);

  // Match the globe to the dropdown's width (kept square).
  const sizeOrbit = () => {
    const w = modelSelect.offsetWidth;
    if (w) { orbitEl.style.width = w + 'px'; orbitEl.style.height = w + 'px'; }
  };
  sizeOrbit();

  // Unit-sphere point -> [viewBoxX, viewBoxY, depth] (depth>0 faces the viewer).
  const proj3 = (x, y, z) => [SPH_C + x * SPH_R, SPH_C - (y * CB - z * SB) * SPH_R, y * SB + z * CB];

  // Sample a ring fn(u)->[x,y,z], splitting into front / back subpaths by depth.
  function ring(fn, N) {
    let front = '', back = '', pf = false, pb = false;
    for (let i = 0; i <= N; i++) {
      const [x, y, z] = fn(i / N);
      const [sx, sy, d] = proj3(x, y, z);
      const pt = sx.toFixed(1) + ' ' + sy.toFixed(1) + ' ';
      if (d >= 0) { front += (pf ? 'L' : 'M') + pt; pf = true; pb = false; }
      else { back += (pb ? 'L' : 'M') + pt; pb = true; pf = false; }
    }
    return [front, back];
  }

  function updateOrbitDot() {
    const la = state.az, fi = state.el;
    const sinLa = Math.sin(la), cosLa = Math.cos(la), sinFi = Math.sin(fi), cosFi = Math.cos(fi);
    const [mf, mb] = ring((u) => { const t = (u - 0.5) * Math.PI, c = Math.cos(t); return [c * sinLa, Math.sin(t), c * cosLa]; }, 32);
    const [pf, pb] = ring((u) => { const s = (u * 2 - 1) * Math.PI; return [cosFi * Math.sin(s), sinFi, cosFi * Math.cos(s)]; }, 48);
    arcMF.setAttribute('d', mf); arcMB.setAttribute('d', mb);
    arcPF.setAttribute('d', pf); arcPB.setAttribute('d', pb);
    const [dsx, dsy] = proj3(cosFi * sinLa, sinFi, cosFi * cosLa);
    orbitDot.style.left = dsx + '%';
    orbitDot.style.top = dsy + '%';
  }

  function applyOrbit() {
    if (!LAYOUTS.find((l) => l.id === state.layout).orbit) return;
    trans.active = false; // orbit follows the pointer directly, no eased morph
    curPos.set(buildLayout(state.layout));
    graph.setPointPositions(curPos, true);
    graph.render(0);
  }

  let orbiting = false;
  function orbitFrom(e) {
    // Arcball: cursor -> point on the (tilted) sphere -> longitude/latitude.
    const r = orbitEl.getBoundingClientRect();
    let sx = ((e.clientX - r.left) / r.width * 100 - SPH_C) / SPH_R;
    let sy = (SPH_C - (e.clientY - r.top) / r.height * 100) / SPH_R;
    const rr = Math.hypot(sx, sy);
    if (rr > 1) { sx /= rr; sy /= rr; }
    const m = Math.max(0, 1 - sx * sx);
    const d = Math.sqrt(Math.max(0, m - sy * sy));
    const y = sy * CB + d * SB;
    const z = -sy * SB + d * CB;
    state.el = clamp(Math.asin(clamp(y, -1, 1)), -EL_MAX, EL_MAX);
    state.az = Math.atan2(sx, z);
    updateOrbitDot();
    applyOrbit();
  }
  orbitEl.addEventListener('pointerdown', (e) => { orbiting = true; orbitEl.setPointerCapture(e.pointerId); orbitFrom(e); });
  orbitEl.addEventListener('pointermove', (e) => { if (orbiting) orbitFrom(e); });
  orbitEl.addEventListener('pointerup', (e) => { orbiting = false; orbitEl.releasePointerCapture(e.pointerId); });
  orbitEl.classList.toggle('hidden', !LAYOUTS.find((l) => l.id === state.layout).orbit);
  updateOrbitDot();

  // --- tooltip -------------------------------------------------------
  const tip = $('#tooltip');
  let mouseX = 0, mouseY = 0;
  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX; mouseY = e.clientY;
    if (!tip.classList.contains('hidden')) { tip.style.left = mouseX + 'px'; tip.style.top = mouseY + 'px'; }
  });
  function showTooltip(i, pin) {
    const p = points[i];
    const born = new Date(startMs + p.b * dayMs).toLocaleString('en', { month: 'short', year: 'numeric' });
    const c = commits[p.c];
    const meta = c && c.g
      ? `${p.h} · added ~${born} · pre-GitHub (Google Sheet, approx)`
      : `${p.h} · added ${born}${c && c.h ? ' · ' + c.h : ''}`;
    tip.innerHTML = `<span class="sw" style="background:${p.h}"></span><span>${p.n}</span><span class="meta">${meta}</span>`;
    tip.style.left = mouseX + 'px';
    tip.style.top = mouseY + 'px';
    tip.classList.remove('hidden');
  }
  function hideTooltip() { tip.classList.add('hidden'); }

  // --- go ------------------------------------------------------------
  refreshBuffers(false);
  graph.render(0);
  setTimeout(() => graph.fitView(700), 120);
  requestAnimationFrame(frame);

  const loading = $('#loading');
  loading.style.opacity = '0';
  setTimeout(() => loading.remove(), 600);

  window.__graph = graph; // handy for debugging
}
