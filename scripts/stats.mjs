// Genesis map generator test harness.
//
// Generates one or more seeded worlds, prints a compact report, and runs the
// invariant checks the renderer and timeline rely on.
//
//   node scripts/genesis-stats.mjs                 # seeds 1 42 20260802
//   node scripts/genesis-stats.mjs 7 8 9
//   node scripts/genesis-stats.mjs --sweep 200     # invariants only, 200 seeds
//
// All distances below are measured in screen-aligned u/v units (u = gx - gy,
// v = gx + gy) — the same space gen.ts plans in and the space site.radius is
// compared against by the renderer.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { generateMap } = await import(join(root, 'src/components/designs/genesis/gen.ts'));
const { TW } = await import(join(root, 'src/components/designs/genesis/types.ts'));

/* ------------------------------ uv geometry ------------------------------ */

const U = (p) => p[0] - p[1];
const V = (p) => p[0] + p[1];
const toUV = (p) => [U(p), V(p)];
const uvOf = (o) => [o.gx - o.gy, o.gx + o.gy];
const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function segDist(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy || 1;
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
}
function polyDist(p, line) {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) best = Math.min(best, segDist(p, line[i], line[i + 1]));
  return best;
}
function segInt(a, b, c, d) {
  const r0 = b[0] - a[0];
  const r1 = b[1] - a[1];
  const s0 = d[0] - c[0];
  const s1 = d[1] - c[1];
  const den = r0 * s1 - r1 * s0;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s1 - (c[1] - a[1]) * s0) / den;
  const u = ((c[0] - a[0]) * r1 - (c[1] - a[1]) * r0) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a[0] + r0 * t, a[1] + r1 * t];
}
function crossings(a, b) {
  const out = [];
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      const p = segInt(a[i], a[i + 1], b[j], b[j + 1]);
      if (p && !out.some((q) => d2(p, q) < 0.9)) out.push(p);
    }
  }
  return out;
}
const plen = (line) => {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += d2(line[i - 1], line[i]);
  return s;
};
const fpR = (w) => w / TW;
const f1 = (n) => n.toFixed(1);

/* ------------------------------- reporting ------------------------------- */

function report(seed) {
  const map = generateMap(seed);
  const river = map.river.map(toUV);
  const roadUV = new Map(map.roads.map((r) => [r.id, r.pts.map(toUV)]));

  const lines = [];
  const say = (s) => lines.push(s);

  say(`\n${'='.repeat(74)}`);
  say(`SEED ${seed}   "${map.valleyName}"`);
  say('='.repeat(74));

  const biomeCount = {};
  for (const c of map.chunks) biomeCount[c.biome] = (biomeCount[c.biome] || 0) + 1;
  say(
    `bounds u[${map.bounds.u0},${map.bounds.u1}] v[${map.bounds.v0},${map.bounds.v1}]  ` +
      `chunks ${map.chunks.length} (${Object.entries(biomeCount).map(([k, v]) => `${k} ${v}`).join(', ')})`
  );
  say(
    `river: ${map.river.length} pts, width ${map.riverWidth}, length ${f1(plen(river))}, ` +
      `mouths (${f1(river[0][0])},${f1(river[0][1])}) -> (${f1(river.at(-1)[0])},${f1(river.at(-1)[1])})`
  );

  say(`\nSITES (${map.sites.length})`);
  for (const s of map.sites) {
    const p = uvOf(s);
    say(
      `  ${s.id} ${s.name.padEnd(20)} u,v ${f1(p[0]).padStart(6)},${f1(p[1]).padStart(6)}  ` +
        `r ${f1(s.radius)}  river ${f1(polyDist(p, river))}  ${s.accent}  ` +
        `${s.buildings.length} bldg / ${s.props.length} props`
    );
  }

  say(`\nROADS (${map.roads.length}, total ${f1(map.roads.reduce((n, r) => n + plen(roadUV.get(r.id)), 0))})`);
  for (const r of map.roads) {
    const line = roadUV.get(r.id);
    say(
      `  ${r.id} ${r.kind.padEnd(8)} w${r.width}  ${r.from}->${r.to}  ` +
        `len ${f1(plen(line)).padStart(6)}  ${line.length} pts  ` +
        `(${f1(line[0][0])},${f1(line[0][1])}) -> (${f1(line.at(-1)[0])},${f1(line.at(-1)[1])})`
    );
  }

  say(`\nBRIDGES (${map.bridges.length})`);
  for (const b of map.bridges) {
    const p = uvOf(b);
    const dr = polyDist(p, river);
    say(`  ${b.id} on ${b.roadId} at (${f1(p[0])},${f1(p[1])}) span ${b.span}  river dist ${f1(dr)} ${dr <= 1 ? 'ok' : 'OFF-RIVER'}`);
  }

  const clearCounts = map.sites.flatMap((s) => s.buildings.map((b) => b.clears.length));
  const withClears = clearCounts.filter((n) => n > 0).length;
  say(
    `\nTREES ${map.trees.length}   SCATTER ${map.scatter.length}   ` +
      `BUILDINGS ${map.sites.reduce((n, s) => n + s.buildings.length, 0)}   ` +
      `SITE PROPS ${map.sites.reduce((n, s) => n + s.props.length, 0)}`
  );
  say(
    `clears: total ${clearCounts.reduce((a, b) => a + b, 0)}, ` +
      `max ${Math.max(...clearCounts)}, mean ${(clearCounts.reduce((a, b) => a + b, 0) / clearCounts.length).toFixed(2)}, ` +
      `plots with >=1: ${withClears}/${clearCounts.length}`
  );

  const roleCount = {};
  const roofCount = {};
  for (const s of map.sites)
    for (const b of s.buildings) {
      roleCount[b.role] = (roleCount[b.role] || 0) + 1;
      roofCount[b.roof] = (roofCount[b.roof] || 0) + 1;
    }
  say(`roles: ${Object.entries(roleCount).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  say(`roofs: ${Object.entries(roofCount).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const landmarks = map.sites.map((s) => {
    const lm = s.buildings.find((b) => b.banner && b.role !== 'homestead');
    return lm ? `${s.id}:${lm.role}` : `${s.id}:NONE`;
  });
  say(`landmarks: ${landmarks.join(', ')}`);
  const kindCount = {};
  for (const t of map.trees) kindCount[t.kind] = (kindCount[t.kind] || 0) + 1;
  say(`tree kinds: ${Object.entries(kindCount).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const scatterKinds = {};
  for (const p of map.scatter) scatterKinds[p.kind] = (scatterKinds[p.kind] || 0) + 1;
  say(`scatter kinds: ${Object.entries(scatterKinds).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  console.log(lines.join('\n'));
  return map;
}

/* ------------------------------- invariants ------------------------------ */

function checks(seed, map) {
  const river = map.river.map(toUV);
  const roadUV = new Map(map.roads.map((r) => [r.id, r.pts.map(toUV)]));
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok, detail });

  /* (a) every site centre is >= 4 from the river centreline */
  {
    let worst = Infinity;
    let who = '';
    for (const s of map.sites) {
      const d = polyDist(uvOf(s), river);
      if (d < worst) {
        worst = d;
        who = s.id;
      }
    }
    check('a  sites >= 4 from river', worst >= 4, `min ${f1(worst)} at ${who}`);
  }

  /* (b) the road network connects every site (union-find) */
  {
    const idx = new Map(map.sites.map((s, i) => [s.id, i]));
    const par = map.sites.map((_, i) => i);
    const find = (x) => (par[x] === x ? x : (par[x] = find(par[x])));
    for (const r of map.roads) par[find(idx.get(r.from))] = find(idx.get(r.to));
    const roots = new Set(map.sites.map((_, i) => find(i)));
    check('b  roads connect all sites', roots.size === 1, `${roots.size} component(s)`);
  }

  /* (c) every road/river crossing carries a bridge within 1.5 */
  {
    let total = 0;
    let bad = 0;
    let worst = 0;
    for (const r of map.roads) {
      for (const x of crossings(roadUV.get(r.id), river)) {
        total++;
        let best = Infinity;
        for (const b of map.bridges) {
          if (b.roadId !== r.id) continue;
          best = Math.min(best, d2(uvOf(b), x));
        }
        worst = Math.max(worst, best === Infinity ? 99 : best);
        if (!(best <= 1.5)) bad++;
      }
    }
    check(
      'c  every crossing has a bridge',
      bad === 0 && total === map.bridges.length,
      `${total} crossings, ${map.bridges.length} bridges, ${bad} unbridged, worst offset ${f1(worst)}`
    );
  }

  /* (d) no two buildings inside a site overlap footprints */
  {
    let bad = 0;
    let worst = Infinity;
    for (const s of map.sites) {
      for (let i = 0; i < s.buildings.length; i++) {
        for (let j = i + 1; j < s.buildings.length; j++) {
          const a = s.buildings[i];
          const b = s.buildings[j];
          const need = fpR(a.w) + fpR(b.w);
          const gap = d2(uvOf(a), uvOf(b)) - need;
          worst = Math.min(worst, gap);
          if (gap < -1e-6) bad++;
        }
      }
    }
    check('d  no overlapping footprints', bad === 0, `${bad} overlaps, tightest gap ${f1(worst)}`);
  }

  /* (e) every clears id exists in trees */
  {
    const ids = new Set(map.trees.map((t) => t.id));
    let bad = 0;
    for (const s of map.sites) for (const b of s.buildings) for (const id of b.clears) if (!ids.has(id)) bad++;
    check('e  clears reference live trees', bad === 0, `${bad} dangling`);
  }

  /* (f) determinism */
  {
    const a = JSON.stringify(generateMap(seed));
    const b = JSON.stringify(generateMap(seed));
    check('f  deterministic', a === b, `${a.length} bytes`);
  }

  /* (g) town names unique */
  {
    const names = map.sites.map((s) => s.name);
    check('g  town names unique', new Set(names).size === names.length, names.join(' / '));
  }

  /* extra, non-fatal but worth watching */
  {
    const f = map.sites[0].buildings[0];
    check(
      'h  founding house is s0-b0 homestead',
      f.id === 's0-b0' && f.role === 'homestead' && f.clears.length === 0 && f.floors === 2 && f.w >= 40 && f.w <= 48,
      `${f.label} w${f.w} floors${f.floors} clears${f.clears.length}`
    );
    let treesOnFounding = 0;
    const fu = uvOf(f);
    for (const t of map.trees) if (d2(uvOf(t), fu) < fpR(f.w) + 2.5) treesOnFounding++;
    check('i  founding plot is clear of trees', treesOnFounding === 0, `${treesOnFounding} trees`);
  }
  {
    let bad = 0;
    let worst = Infinity;
    for (const r of map.roads) {
      const line = roadUV.get(r.id);
      for (const s of map.sites) {
        if (s.id === r.from || s.id === r.to) continue;
        const d = polyDist(uvOf(s), line);
        worst = Math.min(worst, d - (s.radius + 1));
        if (d < s.radius + 1) bad++;
      }
    }
    check('j  roads clear non-endpoint towns', bad === 0, `${bad} intrusions, margin ${f1(worst)}`);
  }
  {
    let bad = 0;
    for (const t of map.trees) {
      if (polyDist(uvOf(t), river) < 1.5 - 1e-6) bad++;
      else
        for (const r of map.roads) {
          if (polyDist(uvOf(t), roadUV.get(r.id)) < 1.2 - 1e-6) {
            bad++;
            break;
          }
        }
    }
    check('k  trees clear river/roads', bad === 0, `${bad} violations`);
  }
  {
    const ok =
      map.trees.length >= 400 &&
      map.trees.length <= 950 &&
      map.scatter.length >= 90 &&
      map.scatter.length <= 220 &&
      map.sites.length >= 5 &&
      map.sites.length <= 7 &&
      map.sites[0].buildings.length >= 8 &&
      map.sites[0].buildings.length <= 10;
    check(
      'l  populations in spec range',
      ok,
      `${map.sites.length} sites, s0 ${map.sites[0].buildings.length} bldg, ${map.trees.length} trees, ${map.scatter.length} scatter, ${map.bridges.length} bridges`
    );
  }
  {
    const w = map.sites.flatMap((s) => s.buildings).filter((b) => b.w % 4 !== 0 || b.w < 24 || b.w > 64);
    check('m  building widths legal', w.length === 0, `${w.length} bad`);
  }

  const pass = results.every((r) => r.ok);
  console.log('\nINVARIANTS');
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(38)} ${r.detail}`);
  }
  console.log(`  => seed ${seed}: ${pass ? 'ALL PASS' : 'FAILURES'}`);
  return pass;
}

/* ---------------------------------- main --------------------------------- */

const argv = process.argv.slice(2);
let allPass = true;

if (argv[0] === '--sweep') {
  const n = Number(argv[1] || 100);
  const fails = [];
  for (let s = 1; s <= n; s++) {
    const map = generateMap(s);
    const out = [];
    const orig = console.log;
    console.log = (...a) => out.push(a.join(' '));
    const ok = checks(s, map);
    console.log = orig;
    if (!ok) {
      fails.push(s);
      console.log(out.join('\n'));
    }
  }
  console.log(`\nsweep ${n} seeds: ${fails.length ? `FAIL ${fails.join(',')}` : 'ALL PASS'}`);
  allPass = fails.length === 0;
} else {
  const seeds = argv.length ? argv.map(Number) : [1, 42, 20260802];
  for (const s of seeds) {
    const map = report(s);
    if (!checks(s, map)) allPass = false;
  }
}

process.exit(allPass ? 0 : 1);
