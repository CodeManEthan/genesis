// Genesis render-performance matrix.
//
// Drives the real page in a real Chrome, reads the `?perf=2` breakdown lines
// off the console, and prints one row per (scenario × viewport). The point is
// not a single number: it is knowing *where* a frame goes, and which phases
// grow with the world versus with the screen.
//
//   node scripts/genesis-perf.mjs                     # the whole matrix
//   node scripts/genesis-perf.mjs --headed            # ...in a real GPU window
//   node scripts/genesis-perf.mjs --only evening-p4   # one scenario
//   node scripts/genesis-perf.mjs --budget 8:16       # gate: avg:max, in ms
//
// Flags:
//   --url <base>        default http://localhost:4321/
//   --reports <n>       perf windows to keep per run (default 2, plus 1 warmup)
//   --headed            launch with a display instead of headless swiftshader
//   --budget avg:max    exit 1 if the worst scenario exceeds either, in ms
//   --only a,b          scenario ids to run (default all)
//   --json <path>       where the machine-readable dump goes
//   --quick             desktop viewport only
//
// Each perf window is 120 painted frames, so a run is roughly
// (1 + reports) × 2s of animation plus page load. The default matrix is
// 7 scenarios × 2 viewports + 1 zoomed case ≈ 15 runs.
//
// Headless caveat: Chrome's headless canvas goes through SwiftShader (software
// rasterisation), which is not what a visitor's machine does. Treat headless
// numbers as an upper bound on the CPU-side cost and a lower bound on nothing;
// `--headed` on a machine with a display is the number that counts.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gdir = join(root, 'src/components/designs/genesis');
const { dayTypeOf } = await import(join(gdir, 'daytype.ts'));
const { generateMap } = await import(join(gdir, 'gen.ts'));
const { buildTimeline } = await import(join(gdir, 'timeline.ts'));
const { TW, TH } = await import(join(gdir, 'types.ts'));

/* --------------------------------- args ---------------------------------- */

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const BASE = flag('url', 'http://localhost:4321/');
const REPORTS = Number(flag('reports', '2'));
const HEADED = has('headed');
const QUICK = has('quick');
const ONLY = (flag('only', '') || '').split(',').filter(Boolean);
const BUDGET = flag('budget', null);
const JSON_OUT = flag('json', `/tmp/genesis-perf-${HEADED ? 'headed' : 'headless'}-${Date.now()}.json`);

/* ------------------------------ seed picking ------------------------------ */
// The rare-day scenarios need seeds that actually *are* those days, and the
// heavy scenario needs the fattest world a short scan can find. Both answers
// come out of the same modules the page uses, so they cannot drift.

function findDay(type, limit = 4000) {
  for (let s = 1; s < limit; s++) {
    const d = dayTypeOf(s);
    if (d.type === type) return { seed: s, ...d };
  }
  throw new Error(`no ${type} seed under ${limit}`);
}

function heaviestSeed(n = 50, pace = 4) {
  let best = null;
  for (let s = 1; s <= n; s++) {
    const map = generateMap(s, pace);
    const stone = map.sites.filter((si) =>
      si.buildings.some((b) => b.material === 'stone')
    ).length;
    const row = {
      seed: s,
      trees: map.trees.length,
      lakes: (map.lakes ?? []).length,
      stoneTowns: stone,
      sites: map.sites.length,
      props: map.sites.reduce((a, si) => a + si.props.length, 0),
    };
    if (!best || row.trees > best.trees) best = row;
  }
  return best;
}

/* ------------------------------- scenarios -------------------------------- */

const storm = findDay('storm');
const aurora = findDay('aurora');
const heavy = heaviestSeed(50, 4);

// A plain day for the ordinary scenarios: no weather to confound the baseline.
const plain = (() => {
  for (let s = 1; s < 500; s++) if (dayTypeOf(s).type === 'normal') return s;
  return 1;
})();

const SCENARIOS = [
  { id: 'midday-p1', label: 'midday · pace 1', seed: plain, pace: 1, t: 12.0 },
  { id: 'midday-p4', label: 'midday · pace 4', seed: plain, pace: 4, t: 12.0 },
  { id: 'evening-p1', label: 'evening 21:30 · pace 1', seed: plain, pace: 1, t: 21.5 },
  { id: 'evening-p4', label: 'evening 21:30 · pace 4', seed: plain, pace: 4, t: 21.5 },
  {
    id: 'storm-p1',
    label: `storm ${fmtHour((storm.from + storm.to) / 2)} · pace 1`,
    seed: storm.seed,
    pace: 1,
    t: Number(((storm.from + storm.to) / 2).toFixed(2)),
  },
  {
    id: 'aurora-p1',
    label: `aurora ${fmtHour(Math.max(22.2, aurora.from + 0.6))} · pace 1`,
    seed: aurora.seed,
    pace: 1,
    t: Number(Math.max(22.2, aurora.from + 0.6).toFixed(2)),
  },
  {
    id: 'heavy-evening-p4',
    label: `heavy seed ${heavy.seed} · evening · pace 4`,
    seed: heavy.seed,
    pace: 4,
    t: 21.5,
  },
];

const VIEWPORTS = [
  { id: 'desktop', label: '1440x900@1', width: 1440, height: 900, dpr: 1 },
  { id: 'phone', label: '390x844@3', width: 390, height: 844, dpr: 3 },
];

/** (scenario, viewport, extra query) triples, in run order. */
const RUNS = [];
for (const sc of SCENARIOS) {
  if (ONLY.length && !ONLY.includes(sc.id)) continue;
  for (const vp of VIEWPORTS) {
    if (QUICK && vp.id !== 'desktop') continue;
    RUNS.push({ sc, vp, zoom: null });
  }
}
// One zoomed-in desktop case: the blit and the halos are the only phases that
// care, and this is where they are asked the most.
const zoomSc = SCENARIOS.find((s) => s.id === 'evening-p4');
if (zoomSc && (!ONLY.length || ONLY.includes(zoomSc.id))) {
  RUNS.push({ sc: zoomSc, vp: VIEWPORTS[0], zoom: 3 });
}

/* --------------------------------- driving -------------------------------- */

const PHASES = ['setup', 'bg', 'roads', 'veg', 'build', 'occl', 'draw', 'fx', 'blit', 'post', 'wild', 'other'];
const TICK = ['amb', 'snap'];
const COUNTS = ['items', 'halos', 'repairs', 'bots', 'smoke', 'sparks', 'trees', 'sites'];

function parsePerf2(line) {
  const out = {};
  const re = /([a-z][a-z0-9]*) (-?[\d.]+)/gi;
  let m;
  while ((m = re.exec(line))) out[m[1]] = Number(m[2]);
  return out;
}

function urlFor({ sc, vp, zoom }) {
  const q = new URLSearchParams({
    perf: '2',
    autoplay: '1',
    speed: '60',
    seed: String(sc.seed),
    pace: String(sc.pace),
    t: String(sc.t),
  });
  if (zoom) q.set('zoom', String(zoom));
  return `${BASE}${BASE.includes('?') ? '&' : '?'}${q}`;
}

async function runOne(browser, run) {
  const page = await browser.newPage();
  await page.setViewport({
    width: run.vp.width,
    height: run.vp.height,
    deviceScaleFactor: run.vp.dpr,
  });
  const windows = [];
  const errors = [];
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (text.startsWith('PERF2 ')) {
      windows.push(parsePerf2(text));
      if (windows.length >= REPORTS + 1) resolveDone();
    } else if (!text.startsWith('PERF ')) {
      errors.push(text.slice(0, 200));
    }
  });

  const url = urlFor(run);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const timeout = new Promise((r) => setTimeout(() => r('timeout'), 90000));
  const why = await Promise.race([done, timeout]);
  const metrics = await page.metrics().catch(() => ({}));
  await page.close();

  // Drop the first window: it covers page warm-up, the first sprite bakes and
  // whatever the JIT has not seen yet.
  const kept = windows.slice(1);
  if (!kept.length) {
    return { ...runMeta(run), url, error: why === 'timeout' ? 'timed out with no perf window' : 'no perf windows', errors };
  }
  const mean = (k) => kept.reduce((a, w) => a + (w[k] ?? 0), 0) / kept.length;
  const phases = Object.fromEntries(PHASES.map((k) => [k, round(mean(k))]));
  const tick = Object.fromEntries(TICK.map((k) => [k, round(mean(k))]));
  const counts = Object.fromEntries(COUNTS.map((k) => [k, round(mean(k), 1)]));
  return {
    ...runMeta(run),
    url,
    avg: round(mean('avg')),
    max: round(Math.max(...kept.map((w) => w.max ?? 0))),
    frame: round(mean('avg') + mean('amb') + mean('snap')),
    phases,
    tick,
    counts,
    jsHeapMB: metrics.JSHeapUsedSize ? round(metrics.JSHeapUsedSize / 1048576, 1) : null,
    zoomActual: kept[0].zoom,
    vw: kept[0].vw,
    vh: kept[0].vh,
    dprActual: kept[0].dpr,
    windows: kept.length,
    errors: errors.slice(0, 5),
  };
}

const runMeta = (run) => ({
  scenario: run.sc.id,
  label: run.sc.label,
  seed: run.sc.seed,
  pace: run.sc.pace,
  t: run.sc.t,
  viewport: run.vp.id,
  viewportLabel: run.vp.label + (run.zoom ? ` zoom${run.zoom}` : ''),
  zoomRequested: run.zoom,
});

const round = (v, d = 2) => Number(Number(v).toFixed(d));
function fmtHour(t) {
  const h = Math.floor(t);
  const m = Math.round((t - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/* -------------------- one-off world construction, in Chrome ---------------
 * The numbers that matter are the browser's, not node's, and the layer
 * canvases only exist where there is a DOM — so this imports the modules
 * straight out of the dev server's module graph on a page that is already
 * open, times a cold build, and reads the real canvas dimensions back. Dev
 * server only; `/src/...` is not a URL in a built site. */

async function probeBuild(browser, cases) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const rows = await page.evaluate(async (cases) => {
    const gen = await import('/src/components/designs/genesis/gen.ts');
    const tl = await import('/src/components/designs/genesis/timeline.ts');
    const sc = await import('/src/components/designs/genesis/scene.ts');
    const dt = await import('/src/components/designs/genesis/daytype.ts');
    const out = [];
    // One throwaway build so the JIT has seen every path before the clock runs.
    sc.buildGenesisScene(gen.generateMapUncached(999001, 1), dt.dayInfo(999001, null));
    for (const c of cases) {
      const t0 = performance.now();
      const map = gen.generateMapUncached(c.seed, c.pace);
      const t1 = performance.now();
      // Exactly what loadWorld() does — the timeline takes no pace of its own.
      tl.buildTimeline(map);
      const t2 = performance.now();
      const scene = sc.buildGenesisScene(map, dt.dayInfo(c.seed, null));
      const t3 = performance.now();
      out.push({
        seed: c.seed,
        pace: c.pace,
        generateMs: t1 - t0,
        timelineMs: t2 - t1,
        sceneMs: t3 - t2,
        worldMs: t2 - t0,
        layerW: scene.layer.width,
        layerH: scene.layer.height,
        vegW: scene.veg.c.width,
        vegH: scene.veg.c.height,
        trees: map.trees.length,
        sites: map.sites.length,
        buildings: map.sites.reduce((a, s) => a + s.buildings.length, 0),
        props: map.sites.reduce((a, s) => a + s.props.length, 0),
        lakes: (map.lakes ?? []).length,
      });
    }
    return out;
  }, cases);
  await page.close();
  return rows;
}

/* ---------------------------- static estimates ---------------------------- */
// The layer geometry is buildGenesisScene()'s, restated. If that formula moves,
// this number is wrong and the comment there should point back here.

function layerDims(map) {
  const B = map.bounds;
  const OVER_U = 14;
  const OVER_V = 28;
  const PAD = 24 + Math.max(OVER_U * (TW / 2), OVER_V * (TH / 2));
  return [
    Math.ceil(B.u1 * (TW / 2) - B.u0 * (TW / 2)) + PAD * 2,
    Math.ceil(B.v1 * (TH / 2) - B.v0 * (TH / 2)) + PAD * 2,
  ];
}

function sceneBytes(W, H, viewport) {
  const px = (w, h) => w * h * 4;
  // The frame buffer is the visible world rect: viewport device px / scale,
  // and at the fitted overview the scale is ~1 device px per world px.
  const fw = Math.ceil(viewport.width * viewport.dpr);
  const fh = Math.ceil(viewport.height * viewport.dpr);
  // Small fry, but named so the total is honest: the 96² wrapped forest tile,
  // the 96² lamp glow, ~250 pooled scenery sprites and one baked canvas per
  // building (`scene.structs` keeps exactly one entry each).
  const small = px(96, 96) * 2 + 250 * px(40, 56) + 100 * px(64, 96);
  return {
    layerPx: `${W}x${H}`,
    terrain: px(W, H),
    veg: px(W, H),
    frame: px(fw, fh),
    sprites: small,
    total: px(W, H) * 2 + px(fw, fh) + small,
  };
}

const MB = (b) => `${(b / 1048576).toFixed(1)}MB`;

/* --------------------------------- output --------------------------------- */

function table(rows, cols) {
  const w = cols.map((c) => Math.max(c.head.length, ...rows.map((r) => String(c.get(r)).length)));
  const line = (cells) =>
    cells.map((s, i) => (cols[i].right ? String(s).padStart(w[i]) : String(s).padEnd(w[i]))).join('  ');
  const out = [line(cols.map((c) => c.head)), line(w.map((n) => '-'.repeat(n)))];
  for (const r of rows) out.push(line(cols.map((c) => c.get(r))));
  return out.join('\n');
}

function topPhases(r, n = 3) {
  if (!r.phases) return '';
  return Object.entries(r.phases)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(' · ');
}

/* ---------------------------------- main ---------------------------------- */

console.log(`genesis-perf — ${HEADED ? 'HEADED (real GPU)' : 'HEADLESS (swiftshader)'} — ${BASE}`);
console.log(
  `seeds: plain ${plain} · storm ${storm.seed} (${fmtHour(storm.from)}-${fmtHour(storm.to)}) · ` +
    `aurora ${aurora.seed} (from ${fmtHour(aurora.from)}) · heavy ${heavy.seed} ` +
    `(${heavy.trees} trees, ${heavy.lakes} lakes, ${heavy.stoneTowns} stone towns, ${heavy.sites} sites)`
);

/* one-off world-construction cost under bare node, for comparison only */
const nodeOneOff = [];
for (const pace of [1, 4]) {
  for (const seed of [plain, heavy.seed]) {
    const t0 = performance.now();
    const map = generateMap(seed, pace);
    const t1 = performance.now();
    buildTimeline(map);
    const t2 = performance.now();
    const [W, H] = layerDims(map);
    nodeOneOff.push({
      seed,
      pace,
      generateMs: round(t1 - t0),
      timelineMs: round(t2 - t1),
      totalMs: round(t2 - t0),
      trees: map.trees.length,
      sites: map.sites.length,
      layerPx: `${W}x${H}`,
    });
  }
}

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: HEADED ? false : 'new',
  args: [
    ...(HEADED ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    '--no-first-run',
    '--hide-scrollbars',
  ],
});
const chrome = await browser.version();
const build = await probeBuild(browser, [
  { seed: plain, pace: 0.5 },
  { seed: plain, pace: 1 },
  { seed: plain, pace: 2 },
  { seed: plain, pace: 4 },
  { seed: heavy.seed, pace: 4 },
]).catch((e) => {
  console.log(`  build probe unavailable (${e.message}) — dev server only`);
  return [];
});
const results = [];
for (const run of RUNS) {
  process.stdout.write(`  running ${run.sc.id} ${run.vp.id}${run.zoom ? ` zoom${run.zoom}` : ''} … `);
  const r = await runOne(browser, run);
  results.push(r);
  console.log(r.error ? `FAILED (${r.error})` : `avg ${r.avg}ms max ${r.max}ms`);
}
await browser.close();

const ok = results.filter((r) => !r.error);

console.log(`\n=== render cost, ${HEADED ? 'headed' : 'headless swiftshader'} (${chrome}) ===\n`);
console.log(
  table(ok, [
    { head: 'scenario', get: (r) => r.label },
    { head: 'viewport', get: (r) => r.viewportLabel },
    { head: 'avg', right: true, get: (r) => r.avg.toFixed(2) },
    { head: 'max', right: true, get: (r) => r.max.toFixed(2) },
    { head: 'tick', right: true, get: (r) => r.frame.toFixed(2) },
    { head: 'top-3 phases', get: (r) => topPhases(r) },
  ])
);

console.log('\n=== phase breakdown, ms/frame ===\n');
console.log(
  table(ok, [
    { head: 'scenario', get: (r) => r.scenario },
    { head: 'vp', get: (r) => r.viewport + (r.zoomRequested ? `/z${r.zoomRequested}` : '') },
    ...PHASES.map((k) => ({ head: k, right: true, get: (r) => r.phases[k].toFixed(2) })),
    ...TICK.map((k) => ({ head: k, right: true, get: (r) => r.tick[k].toFixed(2) })),
  ])
);

console.log('\n=== scene contents (per-frame averages) ===\n');
console.log(
  table(ok, [
    { head: 'scenario', get: (r) => r.scenario },
    { head: 'vp', get: (r) => r.viewport + (r.zoomRequested ? `/z${r.zoomRequested}` : '') },
    ...COUNTS.map((k) => ({ head: k, right: true, get: (r) => r.counts[k] })),
    { head: 'panel', get: (r) => `${r.vw}x${r.vh}@${r.dprActual}` },
    { head: 'zoom', right: true, get: (r) => r.zoomActual },
  ])
);

if (build.length) {
  for (const b of build) {
    b.bytes = sceneBytes(b.layerW, b.layerH, VIEWPORTS[0]);
    b.bytesPhone = sceneBytes(b.layerW, b.layerH, VIEWPORTS[1]);
  }
  console.log('\n=== one-off world construction, in Chrome (cold, JIT-warmed) ===\n');
  console.log(
    table(build, [
      { head: 'seed', right: true, get: (r) => r.seed },
      { head: 'pace', right: true, get: (r) => r.pace },
      { head: 'trees', right: true, get: (r) => r.trees },
      { head: 'sites', right: true, get: (r) => r.sites },
      { head: 'bldgs', right: true, get: (r) => r.buildings },
      { head: 'props', right: true, get: (r) => r.props },
      { head: 'generateMap', right: true, get: (r) => `${r.generateMs.toFixed(1)}ms` },
      { head: 'buildTimeline', right: true, get: (r) => `${r.timelineMs.toFixed(1)}ms` },
      { head: 'world', right: true, get: (r) => `${r.worldMs.toFixed(1)}ms` },
      { head: 'buildScene', right: true, get: (r) => `${r.sceneMs.toFixed(1)}ms` },
    ])
  );
  console.log('\n=== scene memory (measured layer canvases × 4 bytes/px) ===\n');
  console.log(
    table(build, [
      { head: 'seed', right: true, get: (r) => r.seed },
      { head: 'pace', right: true, get: (r) => r.pace },
      { head: 'terrain layer', get: (r) => `${r.layerW}x${r.layerH}` },
      { head: 'veg layer', get: (r) => `${r.vegW}x${r.vegH}` },
      { head: 'terrain', right: true, get: (r) => MB(r.bytes.terrain) },
      { head: 'veg', right: true, get: (r) => MB(r.bytes.veg) },
      { head: 'frame(desktop)', right: true, get: (r) => MB(r.bytes.frame) },
      { head: 'frame(phone)', right: true, get: (r) => MB(r.bytesPhone.frame) },
      { head: 'sprites', right: true, get: (r) => MB(r.bytes.sprites) },
      { head: 'scene total', right: true, get: (r) => MB(r.bytes.total) },
      { head: '23:30 ×2', right: true, get: (r) => MB(r.bytes.total * 2) },
    ])
  );
}

console.log('\n=== the same one-off under bare node (no canvas), for comparison ===\n');
console.log(
  table(nodeOneOff, [
    { head: 'seed', right: true, get: (r) => r.seed },
    { head: 'pace', right: true, get: (r) => r.pace },
    { head: 'trees', right: true, get: (r) => r.trees },
    { head: 'sites', right: true, get: (r) => r.sites },
    { head: 'generateMap', right: true, get: (r) => `${r.generateMs}ms` },
    { head: 'buildTimeline', right: true, get: (r) => `${r.timelineMs}ms` },
    { head: 'total', right: true, get: (r) => `${r.totalMs}ms` },
    { head: 'layer px', get: (r) => r.layerPx },
  ])
);

const failed = results.filter((r) => r.error);
if (failed.length) {
  console.log('\nFAILED RUNS');
  for (const f of failed) console.log(`  ${f.scenario} ${f.viewport}: ${f.error} ${(f.errors || []).join(' | ')}`);
}

const dump = {
  when: new Date().toISOString(),
  mode: HEADED ? 'headed' : 'headless-swiftshader',
  chrome,
  base: BASE,
  reportsKept: REPORTS,
  seeds: { plain, storm, aurora, heavy },
  build,
  nodeOneOff,
  results,
};
writeFileSync(JSON_OUT, JSON.stringify(dump, null, 2));
console.log(`\njson: ${JSON_OUT}`);

if (BUDGET) {
  const [bAvg, bMax] = BUDGET.split(':').map(Number);
  const worstAvg = ok.reduce((a, r) => (r.avg > a.avg ? r : a), ok[0]);
  const worstMax = ok.reduce((a, r) => (r.max > a.max ? r : a), ok[0]);
  const bad = [];
  if (Number.isFinite(bAvg) && worstAvg.avg > bAvg)
    bad.push(`avg ${worstAvg.avg}ms > ${bAvg}ms (${worstAvg.scenario}/${worstAvg.viewport})`);
  if (Number.isFinite(bMax) && worstMax.max > bMax)
    bad.push(`max ${worstMax.max}ms > ${bMax}ms (${worstMax.scenario}/${worstMax.viewport})`);
  if (failed.length) bad.push(`${failed.length} run(s) failed`);
  if (bad.length) {
    console.error(`\nBUDGET FAIL: ${bad.join('; ')}`);
    process.exit(1);
  }
  console.log(`\nBUDGET OK: worst avg ${worstAvg.avg}ms, worst max ${worstMax.max}ms (budget ${bAvg}:${bMax})`);
}
