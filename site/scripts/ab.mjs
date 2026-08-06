// Genesis A/B pixel harness.
//
// A paused Genesis frame is deterministic: with `?seed=&t=` and no autoplay the
// page settles the crowd with a fixed number of fixed-rng steps and paints
// once. So the same code always produces the same pixels, and *different*
// pixels mean the render changed.
//
// This captures the canvas's raw RGBA (not a screenshot: no CSS, no UI chrome,
// no PNG round-trip) for a matrix of worlds, gzips it in the page and writes it
// to disk. Two such captures — one on the old tree, one on the new — are then
// diffed byte for byte.
//
//   node scripts/genesis-ab.mjs capture --out /tmp/ab/before
//   node scripts/genesis-ab.mjs capture --out /tmp/ab/after
//   node scripts/genesis-ab.mjs diff /tmp/ab/before /tmp/ab/after
//
// Flags:
//   --url <base>     default http://localhost:4321/
//   --only a,b       case ids
//   --headed         real GPU (both arms must agree; headless is the default)
//   --settle <ms>    wait before reading pixels (default 2600)

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gdir = join(root, 'src/components/designs/genesis');

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const BASE = flag('url', 'http://localhost:4321/');
const HEADED = has('headed');
const SETTLE = Number(flag('settle', '2600'));
const ONLY = (flag('only', '') || '').split(',').filter(Boolean);

/* ------------------------------- the matrix ------------------------------- */

const { dayTypeOf } = await import(join(gdir, 'daytype.ts'));
const { hashSeed } = await import(join(gdir, 'types.ts'));

function findDay(type, limit = 4000) {
  for (let s = 1; s < limit; s++) if (dayTypeOf(s).type === type) return s;
  throw new Error(`no ${type} seed under ${limit}`);
}
// Same rule as TheGenesis.daySeed(): today's LOCAL date, hashed.
const pad2 = (n) => String(n).padStart(2, '0');
const now = new Date();
const todaySeed = hashSeed(
  `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
);

const SEEDS = [
  { id: 'today', seed: todaySeed },
  { id: 's18', seed: 18 },
  { id: 's23', seed: 23 },
  { id: 'storm', seed: findDay('storm') },
  { id: 'aurora', seed: findDay('aurora') },
];
const TIMES = [7.5, 12, 16, 21.5, 23];

const CASES = [];
for (const s of SEEDS) {
  for (const t of TIMES) {
    CASES.push({ id: `${s.id}-t${t}-p4`, seed: s.seed, pace: 4, t });
  }
}
// Pace 1 is a different roster and a different road order; two hours of it.
for (const s of SEEDS) {
  for (const t of [12, 21.5]) {
    CASES.push({ id: `${s.id}-t${t}-p1`, seed: s.seed, pace: 1, t });
  }
}
// Close-ups: where occlusion repair and the bake's depth order actually show.
for (const s of ['today', 's18']) {
  const seed = SEEDS.find((x) => x.id === s).seed;
  for (const t of [12, 21.5]) {
    CASES.push({ id: `${s}-t${t}-p4-z3`, seed, pace: 4, t, zoom: 3 });
  }
}
// Backward scrub: the page is loaded late in the day and dragged back through
// the scrubber, which is the only path that runs snapshotAt + resetAmbient.
for (const [from, to] of [
  [21, 9],
  [23, 16],
  [16, 7.5],
]) {
  CASES.push({ id: `scrub-${from}-to-${to}`, seed: todaySeed, pace: 4, t: from, scrubTo: to });
}
CASES.push({ id: 'scrub-s18-21-to-9', seed: 18, pace: 4, t: 21, scrubTo: 9 });
// Reduced motion: the tableau path paints once from a settled crowd.
// (The base URL *is* the homepage embed, so every case above already covers it.)
CASES.push({ id: 'reduced-t21.5', seed: todaySeed, pace: 4, t: 21.5, reduced: true });
CASES.push({ id: 'reduced-t12', seed: 18, pace: 4, t: 12, reduced: true });

// First light: no stump, no dressing, so the scenery layer is the standing wood
// and nothing else — which is exactly what it was before any of this.
for (const s of SEEDS) CASES.push({ id: `${s.id}-t0-p4`, seed: s.seed, pace: 4, t: 0.02 });
for (const s of SEEDS) CASES.push({ id: `${s.id}-t1-p4`, seed: s.seed, pace: 4, t: 1 });

const RUNS = CASES.filter((c) => !ONLY.length || ONLY.includes(c.id));

/* -------------------------------- capture -------------------------------- */

const READ = `(async () => {
  const c = document.querySelector('canvas.gen-canvas');
  if (!c) return { error: 'no canvas' };
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter();
  w.write(d); w.close();
  const buf = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  }
  // FNV-1a over the raw pixels, so a mismatch is visible without unpacking.
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193); }
  return { w: c.width, h: c.height, hash: (h >>> 0).toString(16), gz: btoa(s) };
})()`;

function urlFor(c) {
  const q = new URLSearchParams({
    seed: String(c.seed),
    pace: String(c.pace),
    t: String(c.t),
  });
  if (c.zoom) q.set('zoom', String(c.zoom));
  return `${BASE}${BASE.includes('?') ? '&' : '?'}${q}`;
}

/** Drag the transport scrubber, which is the only path through snapshotAt +
 * resetAmbient (a reload at a lower `t` never scrubs at all). */
function scrubTo(to) {
  const el = document.querySelector('.gen-scrub input[type=range]');
  if (!el) return 'no scrubber';
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(el, String(to));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const c = document.querySelector('canvas.gen-canvas');
  return el.value === String(to) ? 'ok' : `stuck at ${el.value}${c ? '' : ' (no canvas)'}`;
}

async function capture(outDir) {
  mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: HEADED ? false : 'new',
    args: [
      ...(HEADED ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
      '--no-first-run',
      '--hide-scrollbars',
    ],
  });
  const index = {};
  for (const c of RUNS) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    if (c.reduced) await page.emulateMediaFeatures([
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ]);
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().startsWith('PERF')) errs.push(m.text().slice(0, 160));
    });
    await page.goto(urlFor(c), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise((r) => setTimeout(r, SETTLE));
    if (c.scrubTo !== undefined) {
      const r = await page.evaluate(scrubTo, c.scrubTo);
      if (r !== 'ok') errs.push(`scrub: ${r}`);
      await new Promise((rr) => setTimeout(rr, 1200));
    }
    const shot = await page.evaluate(READ);
    await page.close();
    if (shot.error) {
      console.log(`  ${c.id}: FAILED ${shot.error}`);
      index[c.id] = { error: shot.error, errs };
      continue;
    }
    writeFileSync(join(outDir, `${c.id}.raw.gz`), Buffer.from(shot.gz, 'base64'));
    index[c.id] = { w: shot.w, h: shot.h, hash: shot.hash, errs: errs.slice(0, 3) };
    console.log(`  ${c.id}: ${shot.w}x${shot.h} ${shot.hash}${errs.length ? ` !! ${errs[0]}` : ''}`);
  }
  await browser.close();
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`\nwrote ${outDir}`);
}

/* --------------------------------- diff ---------------------------------- */

/**
 * Classify a changed pixel.
 *
 * Almost every sprite in the world lays a soft drop shadow —
 * `rgba(65, 58, 85, 0.18)` — under itself, and the two ways a frame can put a
 * sprite down (once, on the layer; or twice, when the occlusion repair draws it
 * again over a mover) differ by exactly one application of it. So "the same
 * pixel, one shadow lighter or darker" is a class worth counting separately
 * from "some other colour entirely".
 */
const SHADOW_A = 0.18;
/**
 * One extra drop shadow, seen through the night sky.
 *
 * In the world buffer a shadow step is `out = in*0.82 + c*0.18` for the one
 * shadow colour every sprite uses. The finished frame is then multiplied by the
 * sky, which is a per-channel constant for the whole image — so on screen the
 * step becomes `out = in*0.82 + q` for an unknown constant `q` that depends
 * only on the hour. Rather than guess `q`, take the modal value of
 * `b - 0.82*a` over the differing pixels: if the diff really is shadow steps,
 * that mode *is* `q`, and everything clustered on it is one step of shadow.
 */
function fitShadow(a, b, w, h) {
  const tally = new Map();
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) continue;
    for (const [from, to, dir] of [[a, b, 1], [b, a, -1]]) {
      const k = `${dir}|${Math.round(to[i] - SHADOW_STEP * from[i])},${Math.round(
        to[i + 1] - SHADOW_STEP * from[i + 1]
      )},${Math.round(to[i + 2] - SHADOW_STEP * from[i + 2])}`;
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
  }
  const best = [...tally].sort((p, q) => q[1] - p[1]).slice(0, 4);
  return best.map(([k]) => {
    const [dir, q] = k.split('|');
    return { dir: Number(dir), q: q.split(',').map(Number) };
  });
}
const SHADOW_STEP = 1 - SHADOW_A;

function fitsShadow(a, b, i, fits) {
  for (const f of fits) {
    const [from, to] = f.dir === 1 ? [a, b] : [b, a];
    let ok = true;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(to[i + k] - (SHADOW_STEP * from[i + k] + f.q[k])) > 1.6) ok = false;
    }
    if (ok) return true;
  }
  return false;
}

/** Cluster differing pixels into coarse boxes so a report can name regions. */
function regions(a, b, w, h) {
  const CELL = 32;
  const cw = Math.ceil(w / CELL);
  const ch = Math.ceil(h / CELL);
  const cells = new Int32Array(cw * ch);
  let n = 0;
  let maxDelta = 0;
  const fits = fitShadow(a, b, w, h);
  let shadowPx = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4;
      if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3]) {
        continue;
      }
      n++;
      if (fitsShadow(a, b, i, fits)) shadowPx++;
      const d = Math.max(
        Math.abs(a[i] - b[i]),
        Math.abs(a[i + 1] - b[i + 1]),
        Math.abs(a[i + 2] - b[i + 2]),
        Math.abs(a[i + 3] - b[i + 3])
      );
      if (d > maxDelta) maxDelta = d;
      cells[((y / CELL) | 0) * cw + ((x / CELL) | 0)]++;
    }
  }
  // Flood-fill occupied cells into boxes.
  const seen = new Uint8Array(cw * ch);
  const boxes = [];
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const k = cy * cw + cx;
      if (!cells[k] || seen[k]) continue;
      const stack = [k];
      seen[k] = 1;
      let x0 = cx, x1 = cx, y0 = cy, y1 = cy, px = 0;
      while (stack.length) {
        const q = stack.pop();
        const qx = q % cw;
        const qy = (q / cw) | 0;
        px += cells[q];
        if (qx < x0) x0 = qx;
        if (qx > x1) x1 = qx;
        if (qy < y0) y0 = qy;
        if (qy > y1) y1 = qy;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const nx = qx + dx;
          const ny = qy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const nk = ny * cw + nx;
          if (cells[nk] && !seen[nk]) {
            seen[nk] = 1;
            stack.push(nk);
          }
        }
      }
      boxes.push({
        x: x0 * CELL,
        y: y0 * CELL,
        w: (x1 - x0 + 1) * CELL,
        h: (y1 - y0 + 1) * CELL,
        px,
      });
    }
  }
  boxes.sort((p, q) => q.px - p.px);
  return { n, maxDelta, boxes, shadowPx };
}

function diff(aDir, bDir) {
  const ai = JSON.parse(readFileSync(join(aDir, 'index.json'), 'utf8'));
  const bi = JSON.parse(readFileSync(join(bDir, 'index.json'), 'utf8'));
  const ids = Object.keys(ai).filter((k) => !ONLY.length || ONLY.includes(k));
  let bad = 0;
  const rows = [];
  for (const id of ids) {
    if (!bi[id]) {
      rows.push({ id, verdict: 'MISSING in B' });
      bad++;
      continue;
    }
    if (ai[id].error || bi[id].error) {
      rows.push({ id, verdict: `ERROR ${ai[id].error || bi[id].error}` });
      bad++;
      continue;
    }
    if (ai[id].hash === bi[id].hash) {
      rows.push({ id, verdict: 'identical', n: 0 });
      continue;
    }
    const A = gunzipSync(readFileSync(join(aDir, `${id}.raw.gz`)));
    const B = gunzipSync(readFileSync(join(bDir, `${id}.raw.gz`)));
    if (A.length !== B.length) {
      rows.push({ id, verdict: `size ${ai[id].w}x${ai[id].h} vs ${bi[id].w}x${bi[id].h}` });
      bad++;
      continue;
    }
    const r = regions(A, B, ai[id].w, ai[id].h);
    const total = ai[id].w * ai[id].h;
    rows.push({
      id,
      verdict: 'DIFF',
      n: r.n,
      pct: ((r.n / total) * 100).toFixed(4),
      maxDelta: r.maxDelta,
      boxes: r.boxes.length,
      shadowPx: r.shadowPx,
      top: r.boxes.slice(0, 6).map((b) => `${b.w}x${b.h}@${b.x},${b.y}:${b.px}px`),
    });
    bad++;
  }
  for (const r of rows) {
    if (r.verdict === 'identical') console.log(`  ${r.id.padEnd(24)} identical`);
    else if (r.verdict === 'DIFF') {
      console.log(
        `  ${r.id.padEnd(24)} DIFF ${String(r.n).padStart(8)}px (${r.pct}%) ` +
          `maxΔ ${r.maxDelta} in ${r.boxes} region(s)` +
          ` | one shadow step: ${((r.shadowPx / r.n) * 100).toFixed(0)}%`
      );
      for (const t of r.top) console.log(`      ${t}`);
    } else console.log(`  ${r.id.padEnd(24)} ${r.verdict}`);
  }
  const same = rows.filter((r) => r.verdict === 'identical').length;
  console.log(`\n${same}/${rows.length} identical, ${bad} differing`);
  writeFileSync(join(bDir, 'diff.json'), JSON.stringify(rows, null, 2));
  return bad;
}

/* ---------------------------------- main ---------------------------------- */

if (cmd === 'capture') {
  const out = flag('out');
  if (!out) throw new Error('--out required');
  console.log(`capturing ${RUNS.length} cases -> ${out} (${HEADED ? 'headed' : 'headless'})`);
  await capture(out);
} else if (cmd === 'diff') {
  const [, a, b] = argv;
  if (!a || !b || !existsSync(a) || !existsSync(b)) throw new Error('usage: diff <dirA> <dirB>');
  const bad = diff(a, b);
  process.exit(bad ? 1 : 0);
} else if (cmd === 'list') {
  for (const c of CASES) console.log(c.id, JSON.stringify(c));
} else {
  console.log('usage: genesis-ab.mjs capture --out DIR | diff DIRA DIRB | list');
  process.exit(2);
}
