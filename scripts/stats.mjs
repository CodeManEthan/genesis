// Genesis map generator test harness.
//
// Generates one or more seeded worlds, prints a compact report, and runs the
// invariant checks the renderer and timeline rely on.
//
//   node scripts/genesis-stats.mjs                 # seeds 1 42 20260802
//   node scripts/genesis-stats.mjs 7 8 9
//   node scripts/genesis-stats.mjs --sweep 200     # invariants only, 200 seeds
//
// Each seed is reported at scale 1 and then checked at every scale in
// SCALES, plus the subset-stability checks that guarantee a smaller scale is a
// strict prefix of a larger one.
//
// All distances below are measured in screen-aligned u/v units (u = gx - gy,
// v = gx + gy) — the same space gen.ts plans in and the space site.radius is
// compared against by the renderer.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  generateMap,
  generateMapUncached,
  woodCharacter,
  QUARRY_REACH,
  STONE_BRIDGE_REACH,
  JETTY_LEN,
  JETTY_REACH,
  JETTY_LAKE_REACH,
} = await import(join(root, 'src/components/designs/genesis/gen.ts'));
const { TW } = await import(join(root, 'src/components/designs/genesis/types.ts'));

/* ---------------------------- renderer coverage --------------------------- */

// Mirrors of what scene.ts can actually draw. A generated kind with no sprite
// here renders as NOTHING (or, for a tree, silently as an oak), which is the
// one failure mode in this generator that leaves no trace in the JSON — so it
// is checked rather than eyeballed. Keep in step with makePools(), TREE_POOL
// and the propSprite() switch in src/components/designs/genesis/scene.ts.
const TREE_SPRITES = new Set(['oak', 'pine', 'blossom', 'hedgerow', 'birch', 'willow', 'fir']);
const PROP_SPRITES = new Set([
  ...TREE_SPRITES,
  'bush', 'rock', 'flowers', 'reeds', 'stump', 'crop', 'haystack', 'fenceL',
  'fenceR', 'shed', 'cart', 'crates', 'lumber', 'barrels', 'well', 'lamp',
  'sheep', 'campfire', 'quarry-blocks',
  // The stone forms of fenceL/fenceR and lamp. Same footprint, same anchor;
  // which of each pair gets emitted is a pure function of quarry-ness.
  'drystoneL', 'drystoneR', 'lamp-stone',
  // resolved by name in propSprite() rather than from a pool
  'nameboard', 'signpost', 'stake', 'crane',
  // boats and jetties: oriented, so they are baked per bearing rather than
  // pooled. `rowboat` is the one kind the scenery layer does NOT bake at all —
  // scene.ts draws it per frame so it can bob.
  'jetty', 'rowboat',
]);

/**
 * The kinds that are ALLOWED to stand in the water, and the only exemption in
 * check (v).
 *
 * A jetty is a pier: it is rooted on the bank and its deck is deliberately out
 * over the water, so the prop's own anchor sits inside the shore margin every
 * other prop is held out of. A rowboat is afloat — moored at a jetty head, or
 * adrift on a big lake as wild scatter. Both are placed by their own
 * bank-crossing solver in gen.ts (see JETTY_REACH), never by the dressing
 * sampler that rejects water, so exempting them here removes no cover from
 * anything else: every other kind is still tested exactly as before.
 */
const AFLOAT = new Set(['jetty', 'rowboat']);

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

/* --------------------------------- lakes --------------------------------- */

// The lake tests below are written entirely against `lk.pts`, the stored
// outline, and never against the analytic rx/ry/rot — deliberately. `pts` is
// what the renderer fills, so testing it is testing what a visitor sees; and a
// bug in the generator's own distance approximation cannot hide behind a
// harness that reuses the same approximation.

/** The outline in u/v, scaled about the lake's centre — same as scene.ts. */
function lakeRingUV(lk, k = 1) {
  const c = uvOf(lk);
  return lk.pts.map((p) => {
    const q = toUV(p);
    return [c[0] + (q[0] - c[0]) * k, c[1] + (q[1] - c[1]) * k];
  });
}

/** Exact even-odd point-in-polygon. */
function inPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][1];
    const yj = poly[j][1];
    if (yi > p[1] !== yj > p[1]) {
      const x = ((poly[j][0] - poly[i][0]) * (p[1] - yi)) / (yj - yi) + poly[i][0];
      if (p[0] < x) inside = !inside;
    }
  }
  return inside;
}

/** Signed shore distance from the outline: negative inside the water. */
function lakeShoreDist(p, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    best = Math.min(best, segDist(p, ring[i], ring[(i + 1) % ring.length]));
  }
  return inPoly(p, ring) ? -best : best;
}

/** Nearest shore over every lake; +Infinity when the valley has none. */
function lakesShoreDist(p, rings) {
  let best = Infinity;
  for (const ring of rings) best = Math.min(best, lakeShoreDist(p, ring));
  return best;
}

/** Perimeter of a closed polygon. */
const ringLen = (ring) => {
  let s = 0;
  for (let i = 0; i < ring.length; i++) s += d2(ring[i], ring[(i + 1) % ring.length]);
  return s;
};

/** A town builds in stone iff every plot on its roster says so. */
const isQuarryTown = (s) =>
  s.buildings.length > 0 && s.buildings.every((b) => b.material === 'stone');

/**
 * The FULL town roster, memoised per seed.
 *
 * Several of gen.ts's rules are functions of the roster the busiest day would
 * raise rather than of the roster today actually raises — quarry-ness itself,
 * and now everything downstream of it. Terrain is the clearest case: which
 * fence runs are walled in stone is decided by the nearest town over the FULL
 * roster, because `scatter` has to come out byte-identical at every pace, and a
 * rule keyed to today's trimmed roster could not manage that.
 *
 * The full roster is exactly the roster at the top of the pace ladder: gen.ts
 * sizes the array from siteFactor(SCALE_MAX) and then founds
 * min(siteFactor(S), array length) of it, so at 4x the two are the same number.
 */
let rosterSeed = null;
let rosterSites = null;
const fullRoster = (seed) => {
  if (rosterSeed !== seed) {
    rosterSeed = seed;
    rosterSites = generateMap(seed, 4).sites;
  }
  return rosterSites;
};

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

  const rings = (map.lakes ?? []).map((lk) => lakeRingUV(lk));
  say(`\nLAKES (${map.lakes?.length ?? 0})`);
  for (let i = 0; i < (map.lakes ?? []).length; i++) {
    const lk = map.lakes[i];
    const c = uvOf(lk);
    const ring = rings[i];
    let wu = 0;
    let wv = 0;
    for (const q of ring) {
      wu = Math.max(wu, Math.abs(q[0] - c[0]) * 2);
      wv = Math.max(wv, Math.abs(q[1] - c[1]) * 2);
    }
    say(
      `  ${lk.id} u,v ${f1(c[0]).padStart(6)},${f1(c[1]).padStart(6)}  ` +
        `axes ${f1(lk.rx * 2)}x${f1(lk.ry * 2)}  extent ${f1(wu)}x${f1(wv)}  ` +
        `perimeter ${f1(ringLen(ring))}  ${lk.pts.length} pts  ` +
        `river ${f1(polyDist(c, river))} ${lk.fed ? 'RIVER-FED' : 'standalone'}`
    );
  }

  say(`\nOUTCROPS (${map.outcrops?.length ?? 0})`);
  for (const o of map.outcrops ?? []) {
    const c = uvOf(o);
    const near = map.sites
      .map((s) => ({ s, d: d2(c, uvOf(s)) - o.radius - s.radius }))
      .sort((a, b) => a.d - b.d || (a.s.id < b.s.id ? -1 : 1))[0];
    say(
      `  ${o.id} u,v ${f1(c[0]).padStart(6)},${f1(c[1]).padStart(6)}  r ${f1(o.radius)}  ` +
        `nearest town ${near ? `${near.s.id} at ${f1(near.d)}` : 'none'}` +
        `${near && near.d <= QUARRY_REACH ? '  -> QUARRY' : ''}`
    );
  }

  say(`\nSITES (${map.sites.length})`);
  for (const s of map.sites) {
    const p = uvOf(s);
    say(
      `  ${s.id} ${s.name.padEnd(20)} u,v ${f1(p[0]).padStart(6)},${f1(p[1]).padStart(6)}  ` +
        `r ${f1(s.radius)}  river ${f1(polyDist(p, river))}  ` +
        `lake ${rings.length ? f1(lakesShoreDist(p, rings)) : '-'}  ${s.accent}  ` +
        `${s.buildings.length} bldg / ${s.props.length} props` +
        `${isQuarryTown(s) ? '  STONE' : ''}`
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

  const rc = map.roads.map((r) => (r.clears || []).length);
  say(
    `road clears: ${rc.join(', ')}  (total ${rc.reduce((a, b) => a + b, 0)}, ` +
      `max ${Math.max(0, ...rc)})`
  );

  say(`\nBRIDGES (${map.bridges.length})`);
  for (const b of map.bridges) {
    const p = uvOf(b);
    const dr = polyDist(p, river);
    say(`  ${b.id} on ${b.roadId} at (${f1(p[0])},${f1(p[1])}) span ${b.span}  river dist ${f1(dr)} ${dr <= 1 ? 'ok' : 'OFF-RIVER'}`);
  }

  const fords = map.fords ?? [];
  say(`\nFORDS (${fords.length})`);
  for (const f of fords) {
    const p = uvOf(f);
    const dr = polyDist(p, river);
    const r = map.roads.find((x) => x.id === f.roadId);
    say(
      `  ${f.id} on ${f.roadId} (${r ? r.kind : '??'}) at (${f1(p[0])},${f1(p[1])}) span ${f.span}  ` +
        `river dist ${f1(dr)} ${dr <= 1 ? 'ok' : 'OFF-RIVER'}`
    );
  }

  const area = (map.bounds.u1 - map.bounds.u0) * (map.bounds.v1 - map.bounds.v0);
  say(`\ntree density ${(map.trees.length / area).toFixed(3)} / u,v unit^2 over ${area} units^2`);
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
  const hist = (items, key) => {
    const n = {};
    for (const it of items) n[key(it)] = (n[key(it)] || 0) + 1;
    return Object.entries(n)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
  };
  const chests = map.chests ?? [];
  say(`\nCHESTS (${chests.length})`);
  for (const c of chests) {
    const p = uvOf(c);
    let road = Infinity;
    for (const r of map.roads) road = Math.min(road, polyDist(p, roadUV.get(r.id)));
    const site = map.sites.find((s) => s.id === c.siteId);
    const paid = site ? c.grantIds.filter((id) => site.buildings.some((b) => b.id === id)) : [];
    say(
      `  ${c.id} ${c.reward.padEnd(8)} u,v ${f1(p[0]).padStart(6)},${f1(p[1]).padStart(6)}  ` +
        `${c.biome.padEnd(6)} ${('“' + c.where + '”').padEnd(18)} ` +
        `road ${f1(road).padStart(5)}  river ${f1(polyDist(p, river)).padStart(5)}  ` +
        `${c.found ? 'FOUND' : 'buried'} by ${c.siteId}${site ? '' : ' (trimmed)'}  ` +
        `pays ${paid.length}/${c.grantIds.length}${c.grantIds.length ? ' [' + c.grantIds.join(' ') + ']' : ''}`
    );
  }

  /* ---- ruins (additive) ------------------------------------------------- */
  const ruins = map.ruins ?? [];
  say(`\nRUINS (${ruins.length})`);
  for (const r of ruins) {
    const p = uvOf(r);
    let road = Infinity;
    for (const rd of map.roads) road = Math.min(road, polyDist(p, roadUV.get(rd.id)));
    let site = Infinity;
    for (const s of map.sites) site = Math.min(site, d2(p, uvOf(s)) - s.radius);
    say(
      `  ${r.id} ${r.kind.padEnd(7)} u,v ${f1(p[0]).padStart(6)},${f1(p[1]).padStart(6)}  ` +
        `${r.biome.padEnd(6)} ${('“' + r.where + '”').padEnd(18)} ` +
        `w ${String(r.w).padStart(2)} floors ${r.floors}  ` +
        `road ${f1(road).padStart(5)}  town ${f1(site).padStart(5)}  ` +
        `river ${f1(polyDist(p, river)).padStart(5)}`
    );
  }
  /* ---- end ruins (additive) --------------------------------------------- */

  say(`\nforest character: ${woodCharacter(seed)}`);
  say(`tree kinds: ${hist(map.trees, (t) => t.kind)}`);
  say(`scatter kinds: ${hist(map.scatter, (p) => p.kind)}`);
  const props = map.sites.flatMap((s) => s.props);
  say(`dressing kinds: ${hist(props, (p) => p.kind)}`);
  // Dressing is the one thing the pace control adds to a town it has already
  // founded, so the shape of that growth is worth watching from here.
  const dress = (sc) => {
    const m = generateMap(seed, sc);
    return `${sc}x ${m.sites.map((s) => s.props.length).join('/')}`;
  };
  say(`dressing per site: ${[0.25, 1, 4].map(dress).join('   ')}`);
  say(`accents: ${map.sites.map((s) => s.accent).join(' ')}`);

  console.log(lines.join('\n'));
  return map;
}

/* ------------------------------- invariants ------------------------------ */

const SCALES = [0.25, 0.5, 1, 2, 4];

function checks(seed, map, scale = 1) {
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

  /* (c) every road/river crossing is carried, and by the right thing:
   *     a highway or a lane bridges the water, a track fords it. Exactly one
   *     of the two per crossing, within 1.5, and nothing left over. */
  {
    const fords = map.fords ?? [];
    let total = 0;
    let bad = 0;
    let wrongKind = 0;
    let worst = 0;
    let nBridged = 0;
    let nForded = 0;
    for (const r of map.roads) {
      const wantFord = r.kind === 'track';
      for (const x of crossings(roadUV.get(r.id), river)) {
        total++;
        let bBest = Infinity;
        for (const b of map.bridges) {
          if (b.roadId !== r.id) continue;
          bBest = Math.min(bBest, d2(uvOf(b), x));
        }
        let fBest = Infinity;
        for (const f of fords) {
          if (f.roadId !== r.id) continue;
          fBest = Math.min(fBest, d2(uvOf(f), x));
        }
        const best = Math.min(bBest, fBest);
        worst = Math.max(worst, best === Infinity ? 99 : best);
        if (!(best <= 1.5)) bad++;
        else if (wantFord ? fBest <= 1.5 : bBest <= 1.5) {
          if (wantFord) nForded++;
          else nBridged++;
        } else wrongKind++;
      }
    }
    check(
      'c  every crossing is carried',
      bad === 0 && wrongKind === 0 && total === map.bridges.length + fords.length,
      `${total} crossings = ${nBridged} bridged + ${nForded} forded, ` +
        `${map.bridges.length} bridges / ${fords.length} fords, ` +
        `${bad} uncrossed, ${wrongKind} wrong kind, worst offset ${f1(worst)}`
    );

    // and the converse: nothing is hung off the wrong class of road, and every
    // ford really is standing in the river rather than beside it
    let strayBridge = 0;
    for (const b of map.bridges) {
      const r = map.roads.find((x) => x.id === b.roadId);
      if (!r || r.kind === 'track') strayBridge++;
    }
    let strayFord = 0;
    let offRiver = 0;
    for (const f of fords) {
      const r = map.roads.find((x) => x.id === f.roadId);
      if (!r || r.kind !== 'track') strayFord++;
      if (!(polyDist(uvOf(f), river) <= 1.0)) offRiver++;
    }
    check(
      'c2 bridges on lanes, fords on tracks',
      strayBridge === 0 && strayFord === 0 && offRiver === 0,
      `${strayBridge} bridge(s) on a track, ${strayFord} ford(s) off a track, ${offRiver} ford(s) off the river`
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

  /* (f) determinism — deliberately uncached, or the second call would be the
     very same object coming back out of generateMap's LRU. */
  {
    const a = JSON.stringify(generateMapUncached(seed, scale));
    const b = JSON.stringify(generateMapUncached(seed, scale));
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
    // Trees may now stand on a planned road — the crews fell them. Only the
    // water still pushes them back.
    let bad = 0;
    for (const t of map.trees) if (polyDist(uvOf(t), river) < 1.5 - 1e-6) bad++;
    check('k  trees clear the river', bad === 0, `${bad} violations`);
  }
  {
    const s0b = map.sites[0].buildings.length;
    const ok =
      map.trees.length >= 1400 &&
      map.trees.length <= 2400 &&
      // The upper bound carries the lake shores and the boulder fields as well
      // as the wild scatter: two lakes ringed with reeds and two outcrops laid
      // out in stone is a legitimate ~120 props on top of the base 100..180.
      map.scatter.length >= 90 &&
      map.scatter.length <= 340 &&
      map.sites.length >= 2 &&
      map.sites.length <= 16 &&
      s0b >= 3 &&
      s0b <= 14 &&
      // Scale 1 must still land on the hand-tuned baseline.
      (scale !== 1 || (map.sites.length >= 5 && map.sites.length <= 7 && s0b >= 8 && s0b <= 10));
    check(
      'l  populations in spec range',
      ok,
      `${map.sites.length} sites, s0 ${s0b} bldg, ${map.trees.length} trees, ${map.scatter.length} scatter, ` +
        `${map.bridges.length} bridges, ${(map.fords ?? []).length} fords`
    );
  }
  {
    const w = map.sites.flatMap((s) => s.buildings).filter((b) => b.w % 4 !== 0 || b.w < 24 || b.w > 64);
    check('m  building widths legal', w.length === 0, `${w.length} bad`);
  }

  /* (n) road clears: live tree, on the route, fracs sane and ascending */
  {
    const ids = new Set(map.trees.map((t) => t.id));
    let missing = 0;
    let offRoute = 0;
    let badFrac = 0;
    let unsorted = 0;
    let worst = 0;
    let total = 0;
    for (const r of map.roads) {
      const line = roadUV.get(r.id);
      let prev = -Infinity;
      for (const c of r.clears || []) {
        total++;
        const t = map.trees.find((x) => x.id === c.tree);
        if (!t) {
          missing++;
          continue;
        }
        if (!ids.has(c.tree)) missing++;
        const d = polyDist(uvOf(t), line);
        worst = Math.max(worst, d);
        if (d > 1.0) offRoute++;
        if (!(c.frac >= 0 && c.frac <= 1)) badFrac++;
        if (c.frac < prev - 1e-9) unsorted++;
        prev = c.frac;
      }
    }
    check(
      'n  road clears valid + ascending',
      missing === 0 && offRoute === 0 && badFrac === 0 && unsorted === 0,
      `${total} claims, ${missing} missing, ${offRoute} off-route, ${badFrac} bad frac, ${unsorted} unsorted, worst dist ${f1(worst)}`
    );
  }

  /* (o) a tree is never claimed twice */
  {
    const seen = new Map();
    let dup = 0;
    const claim = (id, who) => {
      if (seen.has(id)) dup++;
      else seen.set(id, who);
    };
    for (const r of map.roads) for (const c of r.clears || []) claim(c.tree, r.id);
    for (const s of map.sites) for (const b of s.buildings) for (const id of b.clears) claim(id, b.id);
    check('o  no tree claimed twice', dup === 0, `${seen.size} claims, ${dup} duplicated`);
  }

  /* (p) roads run through to the town centres, not to dead ends at the rim */
  {
    let worst = 0;
    let bad = 0;
    for (const r of map.roads) {
      const line = roadUV.get(r.id);
      for (const [end, id] of [[line[0], r.from], [line[line.length - 1], r.to]]) {
        const s = map.sites.find((x) => x.id === id);
        if (!s) continue;
        const d = d2(end, uvOf(s));
        worst = Math.max(worst, d);
        if (d > 2.3) bad++;
      }
    }
    check('p  roads reach town centres', bad === 0, `${bad} short, furthest terminus ${f1(worst)}`);
  }

  /* (q) no roof sits on a road, extensions included */
  {
    let bad = 0;
    let worst = Infinity;
    for (const s of map.sites) {
      for (const b of s.buildings) {
        for (const r of map.roads) {
          const gap = polyDist(uvOf(b), roadUV.get(r.id)) - fpR(b.w);
          worst = Math.min(worst, gap);
          if (gap < 0) bad++;
        }
      }
    }
    check('q  buildings clear of roads', bad === 0, `${bad} paved, tightest ${f1(worst)}`);
  }

  /* (r) every kind the generator emits is something the renderer can draw */
  {
    const missing = new Set();
    for (const t of map.trees) if (!TREE_SPRITES.has(t.kind)) missing.add(`tree:${t.kind}`);
    for (const p of map.scatter) if (!PROP_SPRITES.has(p.kind)) missing.add(p.kind);
    for (const s of map.sites) for (const p of s.props) if (!PROP_SPRITES.has(p.kind)) missing.add(p.kind);
    check(
      'r  every kind has a sprite',
      missing.size === 0,
      missing.size ? `NO SPRITE: ${[...missing].join(', ')}` : `${PROP_SPRITES.size} kinds known`
    );
  }

  /* (t) buried treasure: nought to two, in deep cover, well off every road,
     and paying out only where the day's roster could carry the reward.
     Chests are TERRAIN — the scale-identity half of that is in subsetChecks. */
  {
    const chests = map.chests ?? [];
    const bad = [];
    const ids = new Set();
    let minRoad = Infinity;
    let minRiver = Infinity;
    let minSite = Infinity;
    for (const c of chests) {
      if (ids.has(c.id)) bad.push(`duplicate id ${c.id}`);
      ids.add(c.id);
      const p = uvOf(c);
      const chunk = map.chunks.find(
        (k) => p[0] >= k.u0 && p[0] < k.u1 && p[1] >= k.v0 && p[1] < k.v1
      );
      if (!chunk) bad.push(`${c.id} sits outside every chunk`);
      else if (chunk.biome !== 'forest' && chunk.biome !== 'moor')
        bad.push(`${c.id} buried in ${chunk.biome}`);
      else if (chunk.biome !== c.biome) bad.push(`${c.id} says ${c.biome}, ground says ${chunk.biome}`);
      if (!c.where) bad.push(`${c.id} has nowhere to be`);
      for (const r of map.roads) minRoad = Math.min(minRoad, polyDist(p, roadUV.get(r.id)));
      minRiver = Math.min(minRiver, polyDist(p, river));
      for (const s of map.sites) minSite = Math.min(minSite, d2(p, uvOf(s)) - s.radius);
      for (const o of chests) if (o !== c && d2(p, uvOf(o)) < 12 - 1e-9) bad.push(`${c.id} crowds ${o.id}`);

      if (!(c.siteIndex >= 1)) bad.push(`${c.id} names s0 as its finder`);
      if (c.siteId !== `s${c.siteIndex}`) bad.push(`${c.id} siteId/siteIndex disagree`);
      if (!['coin', 'charter', 'trinket'].includes(c.reward)) bad.push(`${c.id} reward ${c.reward}`);
      if (!c.found && c.grantIds.length) bad.push(`${c.id} was never found but pays out`);
      if (c.reward === 'trinket' && c.grantIds.length) bad.push(`${c.id} is a trinket that pays out`);
      if (c.reward === 'charter' && c.found && c.grantIds.length !== 1)
        bad.push(`${c.id} charter grants ${c.grantIds.length}`);
      for (const id of c.grantIds)
        if (!id.startsWith(`${c.siteId}-`)) bad.push(`${c.id} grant ${id} is not ${c.siteId}'s`);

      const site = map.sites.find((s) => s.id === c.siteId);
      if (site && c.grantIds.length) {
        const here = c.grantIds.filter((id) => site.buildings.some((b) => b.id === id));
        // All of it, or (only where the pace control trimmed the town's roster
        // back past the grant) none of it. Never half a windfall.
        if (here.length && here.length !== c.grantIds.length)
          bad.push(`${c.id} pays out ${here.length}/${c.grantIds.length} at ${scale}x`);
        if (scale >= 1 && here.length !== c.grantIds.length)
          bad.push(`${c.id} reward trimmed at ${scale}x — a normal day must always pay`);
        if (c.reward === 'charter' && here.length && !site.buildings.some((b) => b.role === 'gildhall'))
          bad.push(`${c.id} charter paid out with no gildhall in ${site.id}`);
      }
    }
    // A gildhall exists for exactly one reason.
    for (const s of map.sites)
      for (const b of s.buildings)
        if (
          b.role === 'gildhall' &&
          !chests.some((c) => c.found && c.reward === 'charter' && c.grantIds.includes(b.id))
        )
          bad.push(`${b.id} is a gildhall nobody found a charter for`);

    check(
      't  chests buried off the road',
      chests.length <= 2 &&
        bad.length === 0 &&
        (!chests.length || (minRoad >= 2 && minRiver >= 3 && minSite >= 3)),
      `${chests.length} chest(s)` +
        (chests.length
          ? `, nearest road ${f1(minRoad)}, river ${f1(minRiver)}, town rim ${f1(minSite)}`
          : '') +
        (bad.length ? ` — ${bad.join('; ')}` : '')
    );
  }

  /* (z1) ruins (additive): nought to two, in cover, off every road, every
     green, every shore and every boulder field, and never on top of a chest.
     Ruins are TERRAIN — the scale-identity half of that is in subsetChecks. */
  {
    const ruins = map.ruins ?? [];
    // Its own copy of the lake outlines: the shared `rings` below is declared
    // after this block, and a ruin has to keep its feet dry too.
    const wet = (map.lakes ?? []).map((lk) => lakeRingUV(lk));
    const bad = [];
    const ids = new Set();
    let minRoad = Infinity;
    let minRiver = Infinity;
    let minSite = Infinity;
    for (const r of ruins) {
      if (ids.has(r.id)) bad.push(`duplicate id ${r.id}`);
      ids.add(r.id);
      const p = uvOf(r);
      const chunk = map.chunks.find(
        (k) => p[0] >= k.u0 && p[0] < k.u1 && p[1] >= k.v0 && p[1] < k.v1
      );
      if (!chunk) bad.push(`${r.id} sits outside every chunk`);
      else if (!['forest', 'moor', 'meadow'].includes(chunk.biome))
        bad.push(`${r.id} stands in ${chunk.biome}`);
      else if (chunk.biome !== r.biome)
        bad.push(`${r.id} says ${r.biome}, ground says ${chunk.biome}`);
      if (!r.where) bad.push(`${r.id} has nowhere to be`);
      if (!['corner', 'tower', 'rubble'].includes(r.kind)) bad.push(`${r.id} kind ${r.kind}`);
      if (r.w % 4 !== 0 || r.w < 16) bad.push(`${r.id} footprint ${r.w}`);
      for (const rd of map.roads) minRoad = Math.min(minRoad, polyDist(p, roadUV.get(rd.id)));
      minRiver = Math.min(minRiver, polyDist(p, river));
      for (const s of map.sites) minSite = Math.min(minSite, d2(p, uvOf(s)) - s.radius);
      for (const o of ruins) if (o !== r && d2(p, uvOf(o)) < 16 - 1e-9) bad.push(`${r.id} crowds ${o.id}`);
      for (const c of map.chests ?? [])
        if (d2(p, uvOf(c)) < 7 - 1e-9) bad.push(`${r.id} stands on ${c.id}`);
      if (wet.length && lakesShoreDist(p, wet) < 1.6 - 1e-9) bad.push(`${r.id} stands in a lake`);
      for (const o of map.outcrops ?? [])
        if (d2(p, uvOf(o)) < o.radius + 1.2 - 1e-9) bad.push(`${r.id} stands on ${o.id}`);
    }
    check(
      'z1 ruins overgrown and off the road',
      ruins.length <= 2 &&
        bad.length === 0 &&
        (!ruins.length || (minRoad >= 2 && minRiver >= 2.5 && minSite >= 3.4)),
      `${ruins.length} ruin(s)` +
        (ruins.length
          ? `, nearest road ${f1(minRoad)}, river ${f1(minRiver)}, town rim ${f1(minSite)}`
          : '') +
        (bad.length ? ` — ${bad.join('; ')}` : '')
    );
  }

  /* (s) no two towns wear the same accent */
  {
    const acc = map.sites.map((s) => s.accent);
    check(
      's  site accents distinct',
      new Set(acc).size === acc.length,
      `${new Set(acc).size}/${acc.length} distinct`
    );
  }

  /* --------------------------- lakes and stone --------------------------- */

  const rings = (map.lakes ?? []).map((lk) => lakeRingUV(lk));

  /* (t) lakes are terrain: byte-identical however much the day builds.
     Run once per seed (at scale 1) rather than once per scale, because the
     comparison is between scales and doing it five times says nothing new. */
  if (scale === 1) {
    const a = JSON.stringify(generateMapUncached(seed, 0.25).lakes);
    const b = JSON.stringify(generateMapUncached(seed, 4).lakes);
    const c = JSON.stringify(map.lakes);
    const oa = JSON.stringify(generateMap(seed, 0.25).outcrops);
    const ob = JSON.stringify(generateMap(seed, 4).outcrops);
    check(
      't  lakes/outcrops identical 0.25x..4x',
      a === b && a === c && oa === ob,
      `${map.lakes.length} lakes (${a.length} B), ${map.outcrops.length} outcrops`
    );
  }

  /* (u) the lake shape itself is sane: closed, non-degenerate, in bounds */
  {
    let bad = 0;
    let detail = '';
    for (let i = 0; i < (map.lakes ?? []).length; i++) {
      const lk = map.lakes[i];
      const ring = rings[i];
      const c = uvOf(lk);
      const across = 2 * Math.max(...ring.map((q) => d2(q, c)));
      if (ring.length < 12) bad++;
      // 4..9 units across on the axes is the spec; the wobble is allowed to
      // bulge a little past that at whichever angle it peaks.
      if (!(lk.rx * 2 >= 4 && lk.rx * 2 <= 9 && lk.ry * 2 >= 2.6 && lk.ry <= lk.rx)) {
        bad++;
        detail += ` ${lk.id} axes ${f1(lk.rx * 2)}x${f1(lk.ry * 2)}`;
      }
      if (across > 12) {
        bad++;
        detail += ` ${lk.id} bulges to ${f1(across)}`;
      }
      if (!(lk.rx > 0 && lk.ry > 0)) bad++;
      for (const q of ring) {
        if (q[0] < map.bounds.u0 || q[0] > map.bounds.u1) bad++;
        if (q[1] < map.bounds.v0 || q[1] > map.bounds.v1) bad++;
      }
      // Lakes never overlap one another.
      for (let j = i + 1; j < map.lakes.length; j++) {
        if (lakeShoreDist(uvOf(map.lakes[j]), ring) < 0) bad++;
      }
    }
    check(
      'u  lake outlines well formed',
      bad === 0,
      `${map.lakes?.length ?? 0} lakes${detail}`
    );
  }

  /* (v) nothing stands in the water: no tree, roof, prop, scatter or town */
  if (rings.length) {
    let bad = 0;
    let worst = Infinity;
    let who = '';
    const test = (p, margin, tag) => {
      const d = lakesShoreDist(p, rings);
      if (d - margin < worst) {
        worst = d - margin;
        who = tag;
      }
      if (d < margin) bad++;
    };
    // Margins are the generator's, less a hair of slack for the fact that the
    // generator measures against its analytic shape and this measures against
    // the resolved polygon — a chord always sits marginally inside the curve.
    for (const t of map.trees) test(uvOf(t), 0.6, `tree ${t.id}`);
    for (const p of map.scatter) {
      if (AFLOAT.has(p.kind)) continue; // a boat adrift on the lake — see AFLOAT
      test(uvOf(p), 0.25, `scatter ${p.id}`);
    }
    for (const s of map.sites) {
      test(uvOf(s), s.radius + 1.9, `site ${s.id}`);
      for (const b of s.buildings) test(uvOf(b), fpR(b.w) + 0.9, `bldg ${b.id}`);
      for (const p of s.props) {
        if (AFLOAT.has(p.kind)) continue; // the pier and its boat — see AFLOAT
        test(uvOf(p), 0.8, `prop ${p.id}`);
      }
    }
    const afloat =
      map.scatter.filter((p) => AFLOAT.has(p.kind)).length +
      map.sites.reduce((n, s) => n + s.props.filter((p) => AFLOAT.has(p.kind)).length, 0);
    check(
      'v  nothing stands in a lake',
      bad === 0,
      `${bad} in the water, least slack ${f1(worst)} at ${who}` +
        (afloat ? `, ${afloat} afloat by design` : '')
    );
  } else {
    check('v  nothing stands in a lake', true, 'no lakes');
  }

  /* (w) no road ever crosses lake water — not a vertex, not a segment */
  if (rings.length) {
    let bad = 0;
    let worst = Infinity;
    let who = '';
    for (const r of map.roads) {
      const line = roadUV.get(r.id);
      for (let i = 0; i + 1 < line.length; i++) {
        // Sample the segment as well as its ends: a straight chord can slice a
        // narrow neck of water with both endpoints comfortably on dry land.
        const steps = Math.max(2, Math.ceil(d2(line[i], line[i + 1]) * 3));
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const p = [
            line[i][0] + (line[i + 1][0] - line[i][0]) * t,
            line[i][1] + (line[i + 1][1] - line[i][1]) * t,
          ];
          const d = lakesShoreDist(p, rings);
          if (d < worst) {
            worst = d;
            who = r.id;
          }
          if (d < 0) bad++;
        }
      }
    }
    check(
      'w  roads never cross lake water',
      bad === 0,
      `${bad} samples in the water, closest approach ${f1(worst)} on ${who}`
    );
  } else {
    check('w  roads never cross lake water', true, 'no lakes');
  }

  /* (x) quarry towns: stone is all-or-nothing per town, earned by an outcrop,
     never thatched, always kitted out with the stone yard — and, since the
     material stopped stopping at the walls, lit by stone lamps, walled rather
     than fenced in the fields nearest it, and joined to its fellows by stone
     crossings wherever the rule says so. Every one of those is a pure function
     of quarry-ness or of the terrain, so each is checkable exactly, not
     statistically: the harness recomputes the rule and demands the same answer.

     `quarry` is the roster index -> quarry-ness map the generator works from,
     rebuilt here from the buildings alone so this check never has to trust the
     thing it is checking. */
  {
    let bad = 0;
    let detail = [];
    const quarry = map.sites.map(isQuarryTown);
    const outc = map.outcrops ?? [];
    // Terrain rules read the FULL roster — the same list the generator reads —
    // because `scatter` and `bridges` have to come out the same at every pace
    // and a rule keyed to today's trimmed roster could not manage that.
    const roster = fullRoster(seed);
    const rosterQuarry = new Map(roster.map((s) => [s.id, isQuarryTown(s)]));

    // Lamps. A quarry town's are stone-posted, everyone else's are iron; there
    // is no third answer and no town with one of each.
    for (let i = 0; i < map.sites.length; i++) {
      const s = map.sites[i];
      const want = quarry[i] ? 'lamp-stone' : 'lamp';
      const wrong = s.props.filter(
        (p) => (p.kind === 'lamp' || p.kind === 'lamp-stone') && p.kind !== want
      ).length;
      if (wrong) {
        bad++;
        detail.push(`${s.id} ${wrong} ${want === 'lamp' ? 'stone' : 'iron'} lamp(s)`);
      }
    }

    // Field boundaries. Every run in `scatter` belongs to whichever town of the
    // full roster is nearest it, and takes that town's material.
    for (const p of map.scatter) {
      const dry = p.kind === 'drystoneL' || p.kind === 'drystoneR';
      if (!dry && p.kind !== 'fenceL' && p.kind !== 'fenceR') continue;
      const c = uvOf(p);
      let ni = 0;
      let nd = Infinity;
      for (let i = 0; i < roster.length; i++) {
        const d = d2(c, uvOf(roster[i]));
        if (d < nd) {
          nd = d;
          ni = i;
        }
      }
      if (dry !== rosterQuarry.get(roster[ni].id)) {
        bad++;
        detail.push(`${p.id} ${p.kind} by ${roster[ni].id}`);
      }
    }

    // Crossings. Stone iff both towns the road joins quarry, or the crossing
    // itself came up within STONE_BRIDGE_REACH of bare rock.
    for (const b of map.bridges) {
      const road = map.roads.find((r) => r.id === b.roadId);
      if (!road) {
        bad++;
        detail.push(`${b.id} orphan road ${b.roadId}`);
        continue;
      }
      const qa = rosterQuarry.get(road.from);
      const qz = rosterQuarry.get(road.to);
      const rock = outc.length
        ? Math.min(...outc.map((o) => d2(uvOf(b), uvOf(o)) - o.radius))
        : Infinity;
      const want = (qa && qz) || rock <= STONE_BRIDGE_REACH + 1e-6;
      if (want !== (b.material === 'stone')) {
        bad++;
        detail.push(
          `${b.id} ${b.material ?? 'timber'} but ${road.from}/${road.to} ${
            qa ? 'stone' : 'timber'
          }/${qz ? 'stone' : 'timber'}, rock ${rock === Infinity ? '-' : f1(rock)}`
        );
      }
      if (b.material !== undefined && b.material !== 'stone') {
        bad++;
        detail.push(`${b.id} explicit-timber`);
      }
    }

    for (const s of map.sites) {
      const stone = s.buildings.filter((b) => b.material === 'stone').length;
      const timber = s.buildings.filter((b) => b.material !== undefined && b.material !== 'stone').length;
      if (timber) {
        bad++;
        detail.push(`${s.id} explicit-timber`);
      }
      if (stone && stone !== s.buildings.length) {
        bad++;
        detail.push(`${s.id} mixed ${stone}/${s.buildings.length}`);
      }
      if (!stone) continue;
      // Earned: an outcrop within reach of the rim.
      const near = Math.min(
        ...(map.outcrops ?? []).map((o) => d2(uvOf(s), uvOf(o)) - o.radius - s.radius)
      );
      if (!(near <= QUARRY_REACH + 1e-6)) {
        bad++;
        detail.push(`${s.id} stone but nearest rock ${f1(near)}`);
      }
      if (s.buildings.some((b) => b.roof === 'thatch')) {
        bad++;
        detail.push(`${s.id} thatch on stone`);
      }
      if (!s.props.some((p) => p.kind === 'quarry-blocks')) {
        bad++;
        detail.push(`${s.id} no stone yard`);
      }
    }
    const stoneTowns = quarry.filter(Boolean).length;
    const stoneBr = map.bridges.filter((b) => b.material === 'stone').length;
    const dryRuns = map.scatter.filter(
      (p) => p.kind === 'drystoneL' || p.kind === 'drystoneR'
    ).length;
    check(
      'x  quarry towns coherent',
      bad === 0,
      detail.length
        ? detail.join(', ')
        : `${stoneTowns}/${map.sites.length} stone towns, ${stoneBr}/${map.bridges.length} stone bridges, ${dryRuns} drystone panels`
    );
  }

  /* (y) outcrops sit clear of the towns that quarry them, and of the water */
  {
    let bad = 0;
    let worst = Infinity;
    for (const o of map.outcrops ?? []) {
      const c = uvOf(o);
      for (const s of map.sites) {
        const gap = d2(c, uvOf(s)) - o.radius - s.radius;
        worst = Math.min(worst, gap);
        if (gap < 0) bad++;
      }
      if (polyDist(c, river) < o.radius) bad++;
      if (rings.length && lakesShoreDist(c, rings) < o.radius) bad++;
    }
    check(
      'y  outcrops clear of towns and water',
      bad === 0,
      `${map.outcrops?.length ?? 0} outcrops, tightest town gap ${worst === Infinity ? '-' : f1(worst)}`
    );
  }

  /* (z) boats and jetties: a pier is rooted on dry bank, decks out over live
     water, is within reach of the rim that earned it, and never comes without
     the boat moored at its head. Free boats are afloat or they are nothing. */
  {
    const bad = [];
    let piers = 0;
    const riverHalf = map.riverWidth * Math.SQRT2;
    /** Signed distance to open water: negative in it, positive on the land. */
    const wet = (p) => Math.min(polyDist(p, river) - riverHalf, lakesShoreDist(p, rings));
    for (const s of map.sites) {
      const js = s.props.filter((p) => p.kind === 'jetty');
      const bs = s.props.filter((p) => p.kind === 'rowboat');
      if (js.length > 1) bad.push(`${s.id} has ${js.length} jetties`);
      if (bs.length !== js.length) bad.push(`${s.id}: ${js.length} piers, ${bs.length} boats`);
      for (const j of js) {
        piers++;
        if (typeof j.dir !== 'number') {
          bad.push(`${j.id} has no bearing`);
          continue;
        }
        const root = uvOf(j);
        if (wet(root) < 0) bad.push(`${j.id} rooted in the water`);
        const len = j.len ?? JETTY_LEN;
        if (!(len > 1.2 && len <= JETTY_LEN + 1e-9)) bad.push(`${j.id} deck ${f1(len)}`);
        const head = [root[0] + Math.cos(j.dir) * len, root[1] + Math.sin(j.dir) * len];
        if (wet(head) > 0) bad.push(`${j.id} decks out over dry land`);
        // River piers are held to the tight reach, lake piers to the long one.
        // Which it is, is decided by where the deck ends up: a pier whose head
        // is inside a lake outline is a lake pier however the river runs.
        const off = d2(root, uvOf(s)) - s.radius;
        const max = lakesShoreDist(head, rings) < 0 ? JETTY_LAKE_REACH : JETTY_REACH;
        if (off > max + 0.5) bad.push(`${j.id} ${f1(off)} off the rim`);
      }
      for (const b of bs) if (wet(uvOf(b)) > 0.2) bad.push(`${b.id} moored on the beach`);
    }
    for (const p of map.scatter) {
      if (p.kind === 'rowboat' && wet(uvOf(p)) > 0) bad.push(`${p.id} aground`);
    }
    check(
      'z  jetties straddle the bank',
      bad.length === 0,
      bad.length ? bad.join(', ') : `${piers} pier(s) over ${map.sites.length} towns`
    );
  }

  const pass = results.every((r) => r.ok);
  console.log(`\nINVARIANTS  seed ${seed}  scale ${scale}`);
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(38)} ${r.detail}`);
  }
  console.log(`  => seed ${seed} @ ${scale}x: ${pass ? 'ALL PASS' : 'FAILURES'}`);
  return pass;
}

/* --------------------------- subset stability ---------------------------- */

/**
 * A smaller scale must be a strict prefix of a larger one: same land, same
 * names, same positions, with sites / roads / per-site buildings only ever
 * appended. This is what makes the pace control a live knob instead of a
 * reroll, so it is checked pairwise across every adjacent pair of scales.
 */
function subsetChecks(seed) {
  const maps = SCALES.map((s) => generateMap(seed, s));
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok, detail });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Terrain is scale-invariant, full stop.
  // `chests` is in here on purpose: a chest is terrain. Where it is, what is in
  // it, who finds it and whether the day's digging turns it up at all are all a
  // pure function of the seed. Only the REWARD is allowed to notice the pace,
  // and it does that through the ordinary site/building prefix below.
  // `lakes` and `outcrops` are terrain for the same reason.
  // `ruins` joins them for exactly the same reason: overgrown walls were there
  // before the first house and the day neither raises them nor pulls them down,
  // so where they are and what shape they are in is a pure function of the seed.
  // (The GHOST is not map data at all — it is a function of two seeds and lives
  // in ghost.ts, outside `GenesisMap`, so it is not checked here.)
  for (const field of ['river', 'riverWidth', 'lakes', 'outcrops', 'chunks', 'trees', 'scatter', 'chests', 'ruins', 'bounds', 'content', 'valleyName']) {
    const ok = maps.every((m) => same(m[field], maps[0][field]));
    check(`terrain: ${field} identical`, ok);
  }

  for (let k = 1; k < maps.length; k++) {
    const lo = maps[k - 1];
    const hi = maps[k];
    const tag = `${SCALES[k - 1]}x < ${SCALES[k]}x`;

    check(
      `${tag}: sites grow`,
      hi.sites.length >= lo.sites.length,
      `${lo.sites.length} -> ${hi.sites.length}`
    );
    // Site identity, position, radius, accent, name and dressing must not move.
    let bad = 0;
    let bldBad = 0;
    let bldShrink = 0;
    let propBad = 0;
    let propShrink = 0;
    let propLo = 0;
    let propHi = 0;
    for (let i = 0; i < lo.sites.length; i++) {
      const a = lo.sites[i];
      const b = hi.sites[i];
      if (!b) {
        bad++;
        continue;
      }
      const meta = (x) => ({ id: x.id, name: x.name, gx: x.gx, gy: x.gy, radius: x.radius, accent: x.accent });
      if (!same(meta(a), meta(b))) bad++;
      if (b.buildings.length < a.buildings.length) bldShrink++;
      for (let j = 0; j < a.buildings.length; j++) {
        if (!same(a.buildings[j], b.buildings[j])) bldBad++;
      }
      // Dressing is the one thing a busier day is allowed to add to a town it
      // had already founded, so props are a prefix rather than an equality:
      // the essentials come first and the flavour tail only ever grows.
      if (b.props.length < a.props.length) propShrink++;
      for (let j = 0; j < a.props.length; j++) {
        if (!same(a.props[j], b.props[j])) propBad++;
      }
      propLo += a.props.length;
      propHi += b.props.length;
    }
    check(`${tag}: site prefix identical`, bad === 0, `${bad} mismatched sites`);
    check(`${tag}: buildings are a prefix`, bldBad === 0 && bldShrink === 0, `${bldBad} changed, ${bldShrink} shrank`);
    check(
      `${tag}: props are a prefix`,
      propBad === 0 && propShrink === 0,
      `${propBad} changed, ${propShrink} shrank, ${propLo} -> ${propHi} on the shared sites`
    );

    const roadPrefix =
      hi.roads.length >= lo.roads.length &&
      lo.roads.every((r, i) => same(r, hi.roads[i]));
    check(`${tag}: roads are a prefix`, roadPrefix, `${lo.roads.length} -> ${hi.roads.length}`);

    const bridgePrefix =
      hi.bridges.length >= lo.bridges.length &&
      lo.bridges.every((b, i) => same(b, hi.bridges[i]));
    check(`${tag}: bridges are a prefix`, bridgePrefix, `${lo.bridges.length} -> ${hi.bridges.length}`);

    // Fords hang off the roads exactly as the bridges do, so they trim the
    // same way: by road id, from the tail.
    const loF = lo.fords ?? [];
    const hiF = hi.fords ?? [];
    const fordPrefix = hiF.length >= loF.length && loF.every((f, i) => same(f, hiF[i]));
    check(`${tag}: fords are a prefix`, fordPrefix, `${loF.length} -> ${hiF.length}`);
  }

  // The default argument must be exactly scale 1.
  check(
    'default scale === explicit 1',
    JSON.stringify(generateMap(seed)) === JSON.stringify(generateMap(seed, 1))
  );
  // Out-of-range scales clamp rather than explode.
  check(
    'scale clamps to [0.25, 4]',
    JSON.stringify(generateMap(seed, 0.01)) === JSON.stringify(generateMap(seed, 0.25)) &&
      JSON.stringify(generateMap(seed, 99)) === JSON.stringify(generateMap(seed, 4))
  );

  const pass = results.every((r) => r.ok);
  console.log(`\nSUBSET STABILITY  seed ${seed}`);
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(38)} ${r.detail}`);
  }
  console.log(`  => seed ${seed} subset: ${pass ? 'ALL PASS' : 'FAILURES'}`);
  return pass;
}

/* ------------------------------ chest rates ------------------------------ */

/**
 * How often a day buries treasure, and how often the day's digging turns any of
 * it up. The number that matters is the last one: a discovery on roughly one in
 * three to one in two of the days that have a chest to find. Rarer than that and
 * nobody ever sees the feature; commoner and it stops being luck.
 */
function chestReport(n) {
  let chestDays = 0;
  let findDays = 0;
  let total = 0;
  let found = 0;
  const nHist = {};
  const tier = {};
  const paid = {};
  const where = {};
  for (let s = 1; s <= n; s++) {
    const map = generateMap(s);
    const chests = map.chests ?? [];
    nHist[chests.length] = (nHist[chests.length] ?? 0) + 1;
    if (chests.length) chestDays++;
    let f = 0;
    for (const c of chests) {
      total++;
      tier[c.reward] = (tier[c.reward] ?? 0) + 1;
      where[c.where] = (where[c.where] ?? 0) + 1;
      if (!c.found) continue;
      found++;
      f++;
      const site = map.sites.find((x) => x.id === c.siteId);
      const key =
        c.reward === 'trinket'
          ? 'trinket (nothing owed)'
          : site && c.grantIds.every((id) => site.buildings.some((b) => b.id === id))
            ? `${c.reward} paid`
            : `${c.reward} TRIMMED`;
      paid[key] = (paid[key] ?? 0) + 1;
    }
    if (f) findDays++;
  }
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '--');
  const hist = (o) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
  console.log(`\nBURIED TREASURE over ${n} seeds`);
  console.log(`  chests per day: ${hist(nHist)}   (${chestDays} days with a chest, ${total} chests)`);
  console.log(`  rewards buried: ${hist(tier)}`);
  console.log(`  ground:         ${hist(where)}`);
  console.log(`  found at 1x:    ${found}/${total} chests (${pct(found, total)}), ${hist(paid)}`);
  console.log(
    `  => a discovery on ${findDays}/${chestDays} chest-days (${pct(findDays, chestDays)}), ` +
      `${pct(findDays, n)} of all days`
  );
}

/* ---------------------------------- main --------------------------------- */

const argv = process.argv.slice(2);
let allPass = true;

const quietly = (fn) => {
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(' '));
  let ok;
  try {
    ok = fn();
  } finally {
    console.log = orig;
  }
  return { ok, out };
};

if (argv[0] === '--sweep') {
  const n = Number(argv[1] || 100);
  for (const scale of [1, 4]) {
    const fails = [];
    for (let s = 1; s <= n; s++) {
      const r = quietly(() => checks(s, generateMap(s, scale), scale));
      if (!r.ok) {
        fails.push(s);
        console.log(r.out.join('\n'));
      }
    }
    console.log(`sweep ${n} seeds @ ${scale}x: ${fails.length ? `FAIL ${fails.join(',')}` : 'ALL PASS'}`);
    if (fails.length) allPass = false;
  }
  const subFails = [];
  for (let s = 1; s <= Math.min(n, 60); s++) {
    const r = quietly(() => subsetChecks(s));
    if (!r.ok) {
      subFails.push(s);
      console.log(r.out.join('\n'));
    }
  }
  console.log(`sweep ${Math.min(n, 60)} seeds subset stability: ${subFails.length ? `FAIL ${subFails.join(',')}` : 'ALL PASS'}`);
  if (subFails.length) allPass = false;
  chestReport(n);
} else {
  const seeds = argv.length ? argv.map(Number) : [1, 42, 20260802];
  for (const s of seeds) {
    report(s);
    for (const scale of SCALES) {
      if (!checks(s, generateMap(s, scale), scale)) allPass = false;
    }
    if (!subsetChecks(s)) allPass = false;
  }
}

process.exit(allPass ? 0 : 1);
