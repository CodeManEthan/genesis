// Genesis timeline test harness.
//
// Exercises src/components/designs/genesis/timeline.ts against real generated
// maps when gen.ts exists, and against hand-written fixtures either way (the
// fixtures cover shapes the generator may not produce: a road that founds
// nothing, a site with a single building, a bridge near the start of a road).
//
// Node 22 strips the types, same trick as build-world.mjs.
//
// Usage: node scripts/genesis-timeline-stats.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gdir = join(root, 'src/components/designs/genesis');

const { mulberry32, hashSeed } = await import(join(gdir, 'types.ts'));
const { buildTimeline, emptySnapshot, snapshotAt, advance, RIVAL_POOLS, RIVAL_LINES_MAX } =
  await import(join(gdir, 'timeline.ts'));
/* ---- town rivalries (additive) ---- */
const { rivalryOf } = await import(join(gdir, 'daytype.ts'));

/**
 * Every wager template, compiled to an exact regex ({var} -> .+?), so a
 * finished ledger line can be traced back to the pool it came out of. This is
 * how the harness tells a wager line from a flavour line — see the note on
 * `RIVAL_POOLS` in timeline.ts for why it is done by text rather than by a
 * field on the event.
 */
const RIVAL_RX = [];
for (const [tag, pool] of Object.entries(RIVAL_POOLS)) {
  for (const tpl of pool) {
    const rx = tpl
      .split(/\{\w+\}/)
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.+?');
    RIVAL_RX.push([tag, new RegExp('^' + rx + '$')]);
  }
}
const rivalTag = (text) => {
  for (const [tag, rx] of RIVAL_RX) if (rx.test(text)) return tag;
  return null;
};
/** Roles the loser's-alehouse line is allowed to name. Duplicated from
 * timeline.ts on purpose: a test that imports the answer cannot fail. */
const RIVAL_PUB_ROLES = new Set(['brewhouse', 'hall', 'gildhall']);
/* ---- end town rivalries (additive) ---- */
/* ---- living details II (additive) ---------------------------------------- *
 * The three new details are RENDER-side, but every one of them is a pure
 * function of the plan and the clock, and living.ts is where that arithmetic
 * lives precisely so this file can check it without a canvas. Nothing about
 * the snapshot or the event stream changed for any of them — see (j3) and the
 * living-details section near the bottom.
 * -------------------------------------------------------------------------- */
const {
  LEAN_FOR,
  chopDoneTimes,
  doomedTrees,
  hayFor,
  hayStage,
  leanPhase,
  pileReach,
  pileStage,
} = await import(join(gdir, 'living.ts'));

let generateMap = null;
try {
  ({ generateMap } = await import(join(gdir, 'gen.ts')));
} catch {
  generateMap = null;
}

/* -------------------------------------------------------------------------- */
/* fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const TOWNS = ['Ashfold', 'Merrow', 'Stillwater', 'Byrehollow', 'Thornlea', 'Coldharbour'];
const ROLES = ['cottage', 'hall', 'barn', 'workshop', 'store', 'chapel', 'smithy', 'mill'];
const LABELS = ['The Cottage', 'The Long Hall', 'The Barn', 'The Workshop', 'The Store', 'The Chapel', 'The Smithy', 'The Mill'];

/**
 * A small hand-shaped map: `plan` sites strung along a line, one road between
 * each pair, a bridge on the first road, a wild forest of which only some
 * trees are ever cleared.
 */
function makeFixture(seed, opts) {
  const rng = mulberry32(seed);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const counts = opts.buildings;
  const nSites = counts.length;

  const trees = [];
  for (let i = 0; i < opts.trees; i++) {
    trees.push({
      id: `tr${i}`,
      kind: pick(['oak', 'pine', 'blossom', 'hedgerow']),
      gx: Math.round(rng() * 90),
      gy: Math.round(rng() * 90),
      seed: Math.floor(rng() * 1e9),
    });
  }

  // three disjoint pools: plot trees, route trees, and wild forest that must
  // survive the whole day untouched
  const nPlot = Math.floor(opts.trees * 0.4);
  const nRoute = Math.floor(opts.trees * 0.25);
  const clearable = trees.slice(0, nPlot).map((t) => t.id);
  const routeTrees = trees.slice(nPlot, nPlot + nRoute).map((t) => t.id);
  let cursor = 0;
  let routeCursor = 0;

  const sites = [];
  for (let s = 0; s < nSites; s++) {
    const cx = 20 + s * 22;
    const cy = 20 + s * 10;
    const buildings = [];
    for (let b = 0; b < counts[s]; b++) {
      const ri = Math.floor(rng() * ROLES.length);
      const clears = [];
      if (!(s === 0 && b === 0)) {
        const n = Math.floor(rng() * (opts.plotClears ?? 3)); // trees per plot
        for (let k = 0; k < n && cursor < clearable.length; k++) clears.push(clearable[cursor++]);
      }
      buildings.push({
        id: `s${s}-b${b}`,
        siteId: `s${s}`,
        gx: cx + (b % 3) * 2,
        gy: cy + Math.floor(b / 3) * 2,
        role: ROLES[ri],
        label: LABELS[ri],
        w: 24 + Math.floor(rng() * 8) * 4,
        floors: 1 + Math.floor(rng() * 3),
        roof: 'gable',
        chimney: true,
        awning: false,
        banner: false,
        cupola: false,
        accent: '#c8a24a',
        seed: Math.floor(rng() * 1e9),
        clears,
      });
    }
    // LIVING DETAILS II: `timber` and `hay` were `crates` and `sheep`. Both of
    // those kinds took the generic branch in the prop scheduler and so do these
    // two, with the same single rng draw, so the event stream is byte for byte
    // what it was — and every fixture case now carries a timber yard and a rick
    // for the growth checks near the bottom of this file to bite on.
    const props = [
      { id: `s${s}-well`, kind: 'well', gx: cx - 2, gy: cy, seed: 1 },
      { id: `s${s}-board`, kind: 'nameboard', gx: cx - 3, gy: cy + 1, seed: 2 },
      { id: `s${s}-timber`, kind: 'lumber', gx: cx + 1, gy: cy - 2, seed: 3 },
      { id: `s${s}-lamp0`, kind: 'lamp', gx: cx, gy: cy + 3, seed: 4 },
      { id: `s${s}-lamp1`, kind: 'lamp', gx: cx + 3, gy: cy + 3, seed: 5 },
      { id: `s${s}-hay`, kind: 'haystack', gx: cx + 5, gy: cy + 5, seed: 6 },
    ];
    sites.push({
      id: `s${s}`,
      name: TOWNS[s % TOWNS.length],
      gx: cx,
      gy: cy,
      radius: 6,
      accent: '#c8a24a',
      buildings,
      props,
    });
  }

  const roads = [];
  for (let s = 1; s < nSites; s++) {
    const a = sites[s - 1];
    const b = sites[s];
    const pts = [];
    const n = 6;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      pts.push([
        a.gx + (b.gx - a.gx) * u + Math.sin(u * 3) * 2,
        a.gy + (b.gy - a.gy) * u + Math.cos(u * 2) * 2,
      ]);
    }
    const road = { id: `r${s - 1}`, kind: 'lane', pts, width: 0.5, from: a.id, to: b.id };
    // trees standing on the planned route — a separate pool from the plots,
    // ascending by frac. Omitted entirely when opts.roadClears is falsy, which
    // is the "generator hasn't got round to it" path.
    if (opts.roadClears) {
      const rc = [];
      for (let k = 0; k < opts.roadClears && routeCursor < routeTrees.length; k++) {
        rc.push({
          tree: routeTrees[routeCursor++],
          frac: 0.06 + (k / opts.roadClears) * 0.86 + rng() * 0.02,
        });
      }
      rc.sort((x, y) => x.frac - y.frac);
      if (rc.length) road.clears = rc;
    }
    roads.push(road);
  }
  if (opts.loopRoad && nSites >= 3) {
    // a link road that founds nothing
    const a = sites[nSites - 1];
    const b = sites[0];
    roads.push({
      id: `r-loop`,
      kind: 'track',
      pts: [
        [a.gx, a.gy],
        [(a.gx + b.gx) / 2, a.gy + 14],
        [b.gx, b.gy],
      ],
      width: 0.4,
      from: a.id,
      to: b.id,
    });
  }

  /** a point at arclength-ish fraction `at` along a road polyline */
  const alongRoad = (pts, at) => {
    const i = Math.min(pts.length - 2, Math.floor(at * (pts.length - 1)));
    const f = at * (pts.length - 1) - i;
    return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
  };

  const bridges = [];
  if (roads.length) {
    const [gx, gy] = alongRoad(roads[0].pts, opts.bridgeAt ?? 0.45);
    bridges.push({ id: 'br0', roadId: roads[0].id, gx, gy, span: 4 });
  }

  // Fords, the track's answer to a bridge. `opts.fords` is a list of
  // {road, at}: which road (by index, or 'loop' for the link road) fords the
  // water and where along it. The road is forced to `track` kind, because that
  // is the only class gen.ts ever fords, and (e2) holds the harness to it.
  // A road may not carry both — a crossing is one thing or the other — so a
  // ford on road 0 evicts the bridge that was put there above.
  const fords = [];
  for (const [i, spec] of (opts.fords ?? []).entries()) {
    const road = spec.road === 'loop' ? roads.find((r) => r.id === 'r-loop') : roads[spec.road ?? 0];
    if (!road) continue;
    road.kind = 'track';
    road.width = 0.4;
    for (let k = bridges.length - 1; k >= 0; k--) {
      if (bridges[k].roadId === road.id) bridges.splice(k, 1);
    }
    const [gx, gy] = alongRoad(road.pts, spec.at ?? 0.5);
    fords.push({ id: `fd${i}`, roadId: road.id, gx, gy, span: 3.4 });
  }

  const scatter = [];
  for (let i = 0; i < 12; i++) {
    scatter.push({
      id: `pr${i}`,
      kind: 'rock',
      gx: Math.round(rng() * 90),
      gy: Math.round(rng() * 90),
      seed: i,
    });
  }

  // Buried treasure. `opts.chests` is a list of {reward, site, found, grants}:
  // the map's half of the feature, hand-authored so the timeline can be tested
  // on shapes gen.ts will not always produce — a find with nothing owed, a
  // reward the day's roster cannot carry, two chests in one valley.
  const chests = [];
  for (const [i, spec] of (opts.chests ?? []).entries()) {
    const si = Math.min(spec.site ?? 1, nSites - 1);
    const site = sites[si];
    const n = spec.found && spec.reward !== 'trinket' ? (spec.grants ?? 1) : 0;
    const grantIds = [];
    for (let k = 0; k < n; k++) {
      const b = site.buildings[site.buildings.length - 1 - k];
      if (b) grantIds.unshift(b.id);
    }
    chests.push({
      id: `ch${i}`,
      gx: 74 + i * 9,
      gy: 6 + i * 13,
      seed: 4000 + i * 13,
      biome: i % 2 ? 'moor' : 'forest',
      where: i % 2 ? 'the high moor' : 'the fir wood',
      reward: spec.reward,
      siteIndex: si,
      siteId: site.id,
      found: !!spec.found,
      grantIds: spec.orphanGrant ? [`${site.id}-b999`] : grantIds,
    });
  }

  return {
    version: 1,
    seed,
    bounds: { u0: -80, v0: 0, u1: 80, v1: 200 },
    content: { u0: -60, v0: 10, u1: 60, v1: 180 },
    chunks: [],
    river: [
      [0, 60],
      [40, 40],
      [90, 30],
    ],
    riverWidth: 0.95,
    sites,
    roads,
    bridges,
    fords,
    trees,
    scatter,
    chests,
    valleyName: 'Ashmere Vale',
  };
}

/* -------------------------------------------------------------------------- */
/* geometry (independent reimplementation, for checking road/bridge fracs)    */
/* -------------------------------------------------------------------------- */

function arclen(pts) {
  const cum = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    cum.push(total);
  }
  return { cum, total };
}

function fracOf(pts, gx, gy) {
  const { cum, total } = arclen(pts);
  if (!(total > 0)) return 0;
  let best = Infinity;
  let f = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0];
    const ay = pts[i - 1][1];
    const dx = pts[i][0] - ax;
    const dy = pts[i][1] - ay;
    const l2 = dx * dx + dy * dy;
    let u = l2 > 0 ? ((gx - ax) * dx + (gy - ay) * dy) / l2 : 0;
    u = Math.max(0, Math.min(1, u));
    const d = (ax + dx * u - gx) ** 2 + (ay + dy * u - gy) ** 2;
    if (d < best) {
      best = d;
      f = (cum[i - 1] + u * Math.sqrt(l2)) / total;
    }
  }
  return f;
}

/* -------------------------------------------------------------------------- */
/* checks                                                                     */
/* -------------------------------------------------------------------------- */

const hhmm = (t) => {
  const h = Math.floor(t);
  const m = Math.round((t - h) * 60);
  return `${String(m === 60 ? h + 1 : h).padStart(2, '0')}:${String(m === 60 ? 0 : m).padStart(2, '0')}`;
};

/** @param withLog false serialises the BUILT WORLD only — everything the
 * renderer draws, and nothing the ledger says. That is the form the town-
 * rivalry check needs: narration may add lines, and may not move a nail. */
function serialize(snap, withLog = true) {
  const m = (x) => [...x.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const s = (x) => [...x].sort();
  return JSON.stringify({
    t: snap.t,
    trees: m(snap.trees),
    // living details: fell times. Listed explicitly, because (j) compares
    // serialisations and anything left out of here is silently not checked.
    felled: m(snap.felled ?? new Map()),
    buildings: m(snap.buildings),
    roads: m(snap.roads),
    bridges: m(snap.bridges),
    fords: s(snap.fords ?? []),
    props: s(snap.props),
    chests: m(snap.chests),
    founded: s(snap.founded),
    population: m(snap.population),
    log: withLog ? snap.log : null,
  });
}

function run(label, map, pace = 1) {
  const fails = [];
  const bad = (msg) => fails.push(msg);

  // at pace != 1 the day is deliberately re-scaled and may be cut off at
  // midnight, so the "everything finishes" family of checks does not apply
  const full = pace === 1;
  const truncated = pace < 1;

  const tl = pace === 1 ? buildTimeline(map) : buildTimeline(map, pace);
  const ev = tl.events;

  const siteIds = new Set(map.sites.map((s) => s.id));
  const buildingById = new Map();
  const clearsOf = new Map();
  for (const s of map.sites)
    for (const b of s.buildings) {
      buildingById.set(b.id, b);
      clearsOf.set(b.id, b.clears);
    }
  const treeIds = new Set(map.trees.map((t) => t.id));
  const roadById = new Map(map.roads.map((r) => [r.id, r]));
  const bridgeById = new Map(map.bridges.map((b) => [b.id, b]));
  const fordById = new Map((map.fords ?? []).map((f) => [f.id, f]));
  const propIds = new Set();
  for (const s of map.sites) for (const p of s.props) propIds.add(p.id);
  const plotClears = new Set();
  for (const s of map.sites) for (const b of s.buildings) for (const id of b.clears) plotClears.add(id);
  const roadClears = new Set();
  for (const r of map.roads) for (const c of r.clears ?? []) roadClears.add(c.tree);
  const clearable = new Set([...plotClears, ...roadClears]);

  /* (a) sorted, in range */
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    if (!(e.t >= 0 && e.t < 24)) bad(`(a) event ${i} t=${e.t} out of [0,24)`);
    if (i && ev[i - 1].t > e.t + 1e-12) bad(`(a) not sorted at ${i}: ${ev[i - 1].t} > ${e.t}`);
  }

  /* (b) referenced ids exist + no wild tree felled */
  for (const e of ev) {
    if (e.type === 'found' || e.type === 'arrive' || e.type === 'prop') {
      if (e.siteId && !siteIds.has(e.siteId)) bad(`(b) unknown siteId ${e.siteId}`);
    }
    if (e.type === 'log' && e.siteId && !siteIds.has(e.siteId)) bad(`(b) unknown log siteId ${e.siteId}`);
    if (e.type === 'chop-start' || e.type === 'chop-done') {
      if (!treeIds.has(e.treeId)) bad(`(b) unknown treeId ${e.treeId}`);
      else if (!clearable.has(e.treeId)) bad(`(b) felled wild tree ${e.treeId}`);
    }
    if ((e.type === 'survey' || e.type === 'build') && !buildingById.has(e.buildingId))
      bad(`(b) unknown buildingId ${e.buildingId}`);
    if (e.type === 'road' && !roadById.has(e.roadId)) bad(`(b) unknown roadId ${e.roadId}`);
    if (e.type === 'bridge' && !bridgeById.has(e.bridgeId)) bad(`(b) unknown bridgeId ${e.bridgeId}`);
    if (e.type === 'ford' && !fordById.has(e.fordId)) bad(`(b) unknown fordId ${e.fordId}`);
    if (e.type === 'prop' && !propIds.has(e.propId)) bad(`(b) unknown propId ${e.propId}`);
  }

  /* (c) per building: chops -> survey -> monotonic builds ending at 1 */
  const chopDone = new Map();
  for (const e of ev) if (e.type === 'chop-done') chopDone.set(e.treeId, e.t);
  const chopStart = new Map();
  for (const e of ev) if (e.type === 'chop-start' && !chopStart.has(e.treeId)) chopStart.set(e.treeId, e.t);
  for (const [id, t] of chopDone) {
    if (!chopStart.has(id)) bad(`(c) chop-done without chop-start: ${id}`);
    else if (chopStart.get(id) > t) bad(`(c) chop-done before chop-start: ${id}`);
  }

  const founding = map.sites[0]?.buildings[0]?.id;
  const surveyT = new Map();
  const buildsOf = new Map();
  for (const e of ev) {
    if (e.type === 'survey') {
      if (surveyT.has(e.buildingId)) bad(`(c) two surveys for ${e.buildingId}`);
      surveyT.set(e.buildingId, e.t);
    }
    if (e.type === 'build') {
      if (!buildsOf.has(e.buildingId)) buildsOf.set(e.buildingId, []);
      buildsOf.get(e.buildingId).push(e);
    }
  }
  for (const [id, b] of buildingById) {
    if (id === founding) {
      if (surveyT.has(id) || buildsOf.has(id)) bad(`(c) founding house ${id} should have no events`);
      continue;
    }
    if (!surveyT.has(id)) {
      if (!truncated) bad(`(c) no survey for ${id}`);
      continue;
    }
    const sT = surveyT.get(id);
    for (const treeId of b.clears) {
      if (!treeIds.has(treeId)) continue;
      // road crews have first claim; those come down on the road's schedule
      if (roadClears.has(treeId)) continue;
      if (!chopDone.has(treeId)) {
        if (!truncated) bad(`(c) ${id}: clears tree ${treeId} never felled`);
      } else if (chopDone.get(treeId) > sT + 1e-9)
        bad(`(c) ${id}: tree ${treeId} felled at ${chopDone.get(treeId)} after survey ${sT}`);
    }
    const list = buildsOf.get(id) ?? [];
    if (!list.length) {
      if (!truncated) bad(`(c) no build events for ${id}`);
      continue;
    }
    if (list[0].t < sT - 1e-9) bad(`(c) ${id}: build before survey`);
    let prev = 0.05;
    for (const e of list) {
      if (!(e.progress > prev)) bad(`(c) ${id}: progress not strictly monotonic (${prev} -> ${e.progress})`);
      prev = e.progress;
    }
    if (!truncated && list[list.length - 1].progress !== 1)
      bad(`(c) ${id}: last progress ${prev} !== 1`);
  }

  /* (d) roads monotonic, end at 1 */
  const roadEv = new Map();
  for (const e of ev) {
    if (e.type !== 'road') continue;
    if (!roadEv.has(e.roadId)) roadEv.set(e.roadId, []);
    roadEv.get(e.roadId).push(e);
  }
  for (const r of map.roads) {
    const list = roadEv.get(r.id) ?? [];
    if (!list.length) {
      if (!truncated) bad(`(d) road ${r.id} never built`);
      continue;
    }
    let prev = 0;
    for (const e of list) {
      if (!(e.frac > prev)) bad(`(d) ${r.id}: frac not monotonic (${prev} -> ${e.frac})`);
      prev = e.frac;
    }
    if (!truncated && Math.abs(prev - 1) > 1e-9) bad(`(d) ${r.id}: last frac ${prev} !== 1`);
  }

  /* (e) bridge stages 1,2,3 in order, stage 3 gates the road.
   *     This applies to BRIDGES ONLY. A ford has no stages and gates nothing,
   *     which is checked separately in (e2) below. */
  for (const br of map.bridges) {
    const stages = ev.filter((e) => e.type === 'bridge' && e.bridgeId === br.id);
    const nums = stages.map((s) => s.stage);
    const want = truncated ? '1,2,3'.slice(0, Math.max(0, nums.length * 2 - 1)) : '1,2,3';
    if (nums.join(',') !== want) bad(`(e) ${br.id}: stages [${nums}] !== ${want}`);
    const t3 = nums[nums.length - 1] === 3 ? stages[stages.length - 1].t : Infinity;
    const road = roadById.get(br.roadId);
    if (!road) continue;
    const bf = fracOf(road.pts, br.gx, br.gy);
    const past = (roadEv.get(road.id) ?? []).filter((e) => e.frac > bf + 0.05);
    if (past.length && past[0].t < t3 - 1e-9)
      bad(`(e) ${br.id}: road passed frac ${past[0].frac.toFixed(3)} at ${past[0].t.toFixed(2)} before stage 3 at ${t3.toFixed(2)} (bridgeFrac ${bf.toFixed(3)})`);
  }

  /* (e2) fords: narrated exactly once, on a track, and holding nothing up */
  for (const fd of map.fords ?? []) {
    const hits = ev.filter((e) => e.type === 'ford' && e.fordId === fd.id);
    if (hits.length > 1) bad(`(e2) ${fd.id}: narrated ${hits.length} times, want 1`);
    else if (!hits.length && !truncated) bad(`(e2) ${fd.id}: never narrated`);
    const road = roadById.get(fd.roadId);
    if (!road) {
      bad(`(e2) ${fd.id}: hangs off unknown road ${fd.roadId}`);
      continue;
    }
    if (road.kind !== 'track') bad(`(e2) ${fd.id}: on a ${road.kind}, fords are for tracks`);
    // a ford must never emit bridge stages, and no bridge may sit on its road
    if (ev.some((e) => e.type === 'bridge' && bridgeById.get(e.bridgeId)?.roadId === road.id))
      bad(`(e2) ${fd.id}: road ${road.id} is a track but carries bridge events`);
    if (!hits.length) continue;
    // The road head must already have reached the water when the crossing is
    // narrated — and, crucially, must NOT have paused for it: the very event
    // that carries the road to the ford is the one the ford rides on.
    const ff = fracOf(road.pts, fd.gx, fd.gy);
    const list = roadEv.get(road.id) ?? [];
    const reached = list.filter((e) => e.frac >= ff - 0.06 && e.t <= hits[0].t + 1e-9);
    if (!reached.length)
      bad(`(e2) ${fd.id}: narrated at ${hits[0].t.toFixed(2)} before the road reached frac ${ff.toFixed(3)}`);
    // no dead stop at the water: the gap either side of the ford is no worse
    // than the road's own median step, plus generous slack for felling
    const after = list.filter((e) => e.frac > ff + 0.02);
    if (after.length && list.length > 2) {
      const steps = [];
      for (let i = 1; i < list.length; i++) steps.push(list[i].t - list[i - 1].t);
      steps.sort((a, b) => a - b);
      const med = steps[Math.floor(steps.length / 2)];
      const gap = after[0].t - hits[0].t;
      if (gap > Math.max(0.5, med * 6 + 0.5))
        bad(`(e2) ${fd.id}: road stalled ${gap.toFixed(2)}h at the ford (median step ${med.toFixed(2)}h)`);
    }
  }

  /* (f) non-s0 sites founded after their road arrives, before their buildings */
  const foundT = new Map();
  for (const e of ev) if (e.type === 'found' && !foundT.has(e.siteId)) foundT.set(e.siteId, e.t);
  for (let i = 1; i < map.sites.length; i++) {
    const s = map.sites[i];
    if (!foundT.has(s.id)) {
      if (!truncated) bad(`(f) site ${s.id} never founded`);
      // truncated day: the site was never reached, so it must be untouched
      else
        for (const b of s.buildings)
          if (surveyT.has(b.id) || buildsOf.has(b.id))
            bad(`(f) ${b.id} has events but ${s.id} was never founded`);
      continue;
    }
    const fT = foundT.get(s.id);
    for (const b of s.buildings) {
      const es = [
        ...(buildsOf.get(b.id) ?? []),
        ...(surveyT.has(b.id) ? [{ t: surveyT.get(b.id) }] : []),
      ];
      for (const e of es) if (e.t < fT - 1e-9) bad(`(f) ${b.id} event at ${e.t} before found ${fT}`);
    }
    const touching = map.roads.filter((r) => r.from === s.id || r.to === s.id);
    if (touching.length) {
      const ok = touching.some((r) =>
        (roadEv.get(r.id) ?? []).some((e) => e.frac >= 0.95 && e.t <= fT + 1e-9),
      );
      if (!ok) bad(`(f) ${s.id} founded at ${fT.toFixed(2)} with no road at frac>=0.95 yet`);
    }
  }
  if (map.sites.length && foundT.has(map.sites[0].id))
    bad(`(f) sites[0] should not emit a found event (it exists at t=0)`);

  /* (g) the last roof lands in the evening window */
  const builds = ev.filter((e) => e.type === 'build');
  const lastBuild = builds.length ? builds[builds.length - 1].t : 0;
  if (full && builds.length && !(lastBuild >= 19.5 && lastBuild <= 22.5))
    bad(`(g) last build at ${hhmm(lastBuild)} outside 19:30..22:30`);

  /* (h) determinism */
  const again = pace === 1 ? buildTimeline(map) : buildTimeline(map, pace);
  if (JSON.stringify(again.events) !== JSON.stringify(ev))
    bad(`(h) buildTimeline not deterministic at pace ${pace}`);

  /* (i) end state complete */
  const end = snapshotAt(map, tl, 24);
  if (!truncated) {
    for (const [id] of buildingById) {
      const st = end.buildings.get(id);
      if (!st || st.status !== 'done' || st.progress !== 1)
        bad(`(i) ${id} not done at t=24 (${st ? st.status + ' ' + st.progress : 'missing'})`);
    }
    for (const r of map.roads)
      if (end.roads.get(r.id) !== 1) bad(`(i) road ${r.id} frac ${end.roads.get(r.id)} !== 1`);
    for (const b of map.bridges)
      if (end.bridges.get(b.id) !== 3) bad(`(i) bridge ${b.id} stage ${end.bridges.get(b.id)} !== 3`);
    for (const f of map.fords ?? [])
      if (!end.fords?.has(f.id)) bad(`(i) ford ${f.id} never crossed`);
    for (const s of map.sites) if (!end.founded.has(s.id)) bad(`(i) site ${s.id} never founded`);
    for (const id of propIds) if (!end.props.has(id)) bad(`(i) prop ${id} never appeared`);
  } else {
    // the sun goes down on unfinished work — that is the whole point
    const unfinished = [...end.buildings.values()].filter((b) => b.status !== 'done').length;
    if (!unfinished) bad(`(i') pace ${pace}: every building finished, expected some still up on props`);
    if (map.roads.length) {
      const partial = map.roads.filter((r) => (end.roads.get(r.id) ?? 0) < 1).length;
      if (!partial) bad(`(i') pace ${pace}: every road reached frac 1, expected some part-built`);
    }
  }

  /* (j) incremental advance == full recompute */
  const hop = emptySnapshot(map);
  advance(hop, tl, 8);
  advance(hop, tl, 24);
  if (serialize(hop) !== serialize(end)) bad(`(j) two-hop advance != snapshotAt(24)`);

  const hop3 = emptySnapshot(map);
  for (let t = 0.5; t <= 24.0001; t += 0.5) advance(hop3, tl, Math.min(t, 24));
  if (serialize(hop3) !== serialize(end)) bad(`(j) 48-hop advance != snapshotAt(24)`);

  /* (j2) living details: fell times agree with the chop-done events, and with
   * `trees` — the felled log's whole clock hangs off this map, so a stump with
   * no fell time (or a fell time with no stump) is a log that never lies down
   * or never gets hauled. Checked at mid-day too, where `felled` is partial. */
  for (const [id, t] of end.felled ?? []) {
    if (chopDone.get(id) !== t) bad(`(j2) felled[${id}] = ${t}, chop-done at ${chopDone.get(id)}`);
    if (end.trees.get(id) !== 'stump') bad(`(j2) felled[${id}] but tree is ${end.trees.get(id)}`);
  }
  for (const [id, st] of end.trees) {
    if (st === 'stump' && !(end.felled ?? new Map()).has(id))
      bad(`(j2) tree ${id} is a stump at t=24 with no fell time`);
  }
  {
    const mid = snapshotAt(map, tl, 12);
    for (const [id, t] of mid.felled ?? []) {
      if (!(t <= 12 + 1e-9)) bad(`(j2) felled[${id}] = ${t} present in the t=12 snapshot`);
      if (mid.trees.get(id) !== 'stump') bad(`(j2) t=12: felled[${id}] but tree is not a stump`);
    }
  }

  /* (j3) living details II: the half-fallen tree.
   *
   * The lean is the last `LEAN_FOR` of a chop and nothing else — no new event,
   * no new snapshot field, no ambient clock. Two things have to hold for that
   * to be honest, and both are checkable here without ever drawing anything:
   *
   *   the window is INSIDE the chop   a tree may only be drawn leaning while
   *                                   the snapshot says it is `felling`, so
   *                                   the renderer's own gate is the invariant:
   *                                   at every sampled moment, every tree with
   *                                   a lean phase is a felling tree. A chop
   *                                   shorter than LEAN_FOR clamps by itself.
   *   it ENDS at the fall             phase 1 is `chop-done`, which is the
   *                                   instant the stump and the log appear.
   *
   * Sampled at the two edges and the middle of every lean window in the day,
   * which is where an off-by-one would live if there were one. */
  {
    const map0 = chopDoneTimes(tl);
    if (map0.size !== chopDone.size) bad(`(j3) chopDoneTimes saw ${map0.size} of ${chopDone.size} falls`);
    for (const [id, cd] of map0) {
      if (chopDone.get(id) !== cd) bad(`(j3) chopDoneTimes[${id}] = ${cd}, event at ${chopDone.get(id)}`);
      const cs = chopStart.get(id);
      if (cs === undefined) bad(`(j3) ${id} falls at ${hhmm(cd)} with no chop-start`);
      else if (!(cs < cd)) bad(`(j3) ${id}: chop-start ${hhmm(cs)} not before chop-done ${hhmm(cd)}`);
      // the phase runs 0 -> 1 across the window, and is -1 on both sides of it
      if (leanPhase(cd, cd - LEAN_FOR - 1e-9) !== -1) bad(`(j3) ${id} leaning before its window`);
      if (leanPhase(cd, cd) !== -1) bad(`(j3) ${id} still leaning at chop-done`);
      const p0 = leanPhase(cd, cd - LEAN_FOR + 1e-9);
      const p1 = leanPhase(cd, cd - 1e-9);
      if (!(p0 >= 0 && p0 < 0.01)) bad(`(j3) ${id} phase ${p0} at the top of the window`);
      if (!(p1 > 0.99 && p1 <= 1)) bad(`(j3) ${id} phase ${p1} at the bottom of the window`);
    }
    // …and the gate itself: sampled inside every window, the tree is felling.
    // One forward walk, not a snapshot each — the samples are sorted and
    // `advance` is the same state the renderer would be looking at.
    // A road crew working against the head's deadline can hurry a tree down in
    // 24 SECONDS, which is a chop shorter than the lean — so the window a tree
    // is actually seen leaning through is the lean window intersected with its
    // own chop, and the probes are taken inside that. That intersection is not
    // arithmetic anywhere in the renderer: it falls out of drawing a lean only
    // for a tree the snapshot calls `felling`, which is what this checks.
    const probes = [];
    for (const [id, cd] of map0) {
      const from = Math.max(chopStart.get(id) ?? cd, cd - LEAN_FOR);
      for (const at of [(from + cd) / 2, cd - 1e-6]) {
        if (at > from && at < 24 && leanPhase(cd, at) >= 0) probes.push([at, id]);
      }
    }
    probes.sort((a, b) => a[0] - b[0]);
    const walk = emptySnapshot(map);
    let leaned = 0;
    for (const [at, id] of probes) {
      advance(walk, tl, at);
      const st = walk.trees.get(id);
      if (st !== 'felling') bad(`(j3) ${id} leaning at ${hhmm(at)} but the snapshot says ${st}`);
      else leaned++;
    }
    if (full && chopDone.size && !leaned) bad(`(j3) not one tree ever went over`);
  }

  /* (l) road felling: nothing is left standing on finished road surface */
  for (const r of map.roads) {
    const list = roadEv.get(r.id) ?? [];
    for (const c of r.clears ?? []) {
      if (!treeIds.has(c.tree)) continue;
      // the first road event that carries the surface past this tree
      const passes = list.find((e) => e.frac >= c.frac - 1e-12);
      if (!passes) continue; // truncated before the head got there
      const down = chopDone.get(c.tree);
      if (down === undefined)
        bad(`(l) ${r.id}: tree ${c.tree} at frac ${c.frac.toFixed(3)} never felled, but road reached ${passes.frac.toFixed(3)}`);
      else if (!(down < passes.t))
        bad(
          `(l) ${r.id}: tree ${c.tree} felled at ${hhmm(down)} but road passed frac ` +
            `${c.frac.toFixed(3)} at ${hhmm(passes.t)}`,
        );
    }
    // every route tree comes down (roads have first claim over plots)
    if (!truncated)
      for (const c of r.clears ?? []) {
        if (!treeIds.has(c.tree)) continue;
        if (!chopDone.has(c.tree)) bad(`(l) ${r.id}: route tree ${c.tree} never felled`);
      }
  }

  /* (l2) at most 3 axes in flight per road crew */
  for (const r of map.roads) {
    const spans = [];
    for (const c of r.clears ?? []) {
      const a = chopStart.get(c.tree);
      const b = chopDone.get(c.tree);
      if (a === undefined) continue;
      spans.push([a, 1], [b === undefined ? 24 : b, -1]);
    }
    spans.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let open = 0;
    let peak = 0;
    for (const [, d] of spans) {
      open += d;
      if (open > peak) peak = open;
    }
    if (peak > 3) bad(`(l2) ${r.id}: ${peak} axes in flight at once, cap is 3`);
  }

  /* (m) no tree felled twice */
  const startCount = new Map();
  const doneCount = new Map();
  for (const e of ev) {
    if (e.type === 'chop-start') startCount.set(e.treeId, (startCount.get(e.treeId) ?? 0) + 1);
    if (e.type === 'chop-done') doneCount.set(e.treeId, (doneCount.get(e.treeId) ?? 0) + 1);
  }
  for (const [id, n] of startCount) if (n > 1) bad(`(m) tree ${id} felled ${n} times`);
  for (const [id, n] of doneCount) if (n > 1) bad(`(m) tree ${id} chop-done ${n} times`);

  /* (n2) buried treasure: one dig and one lid per chest, only for the chests
     the map actually buried and actually found, and always before the town
     starts spending the proceeds */
  const chests = map.chests ?? [];
  const chestById = new Map(chests.map((c) => [c.id, c]));
  const digT = new Map();
  const discT = new Map();
  for (const e of ev) {
    if (e.type !== 'dig' && e.type !== 'discover') continue;
    const into = e.type === 'dig' ? digT : discT;
    if (!chestById.has(e.chestId)) bad(`(n2) unknown chestId ${e.chestId}`);
    if (into.has(e.chestId)) bad(`(n2) ${e.chestId}: two ${e.type} events`);
    else into.set(e.chestId, e.t);
  }
  for (const [id, t] of discT) {
    const c = chestById.get(id);
    if (!c) continue;
    if (!c.found) bad(`(n2) ${id} was opened, but the map never found it`);
    if (!digT.has(id)) bad(`(n2) ${id} was opened without anybody digging for it`);
    else if (digT.get(id) > t + 1e-9)
      bad(`(n2) ${id}: dug at ${hhmm(digT.get(id))}, already open at ${hhmm(t)}`);
    // Cause, then effect: nothing a chest paid for may be staked out first.
    for (const gid of c.grantIds) {
      const sT = surveyT.get(gid);
      if (sT === undefined) continue;
      if (sT < t - 1e-9)
        bad(`(n2) ${id}: reward ${gid} surveyed at ${hhmm(sT)}, chest not open until ${hhmm(t)}`);
    }
  }
  for (const id of digT.keys())
    if (!discT.has(id) && !truncated) bad(`(n2) ${id} was dug for and never opened`);
  if (!truncated)
    for (const c of chests)
      if (c.found && !discT.has(c.id)) bad(`(n2) ${c.id} was found by the map but never opened`);
  if (!truncated) {
    for (const c of chests) {
      const st = end.chests.get(c.id);
      if (c.found && st !== 'open') bad(`(n2) ${c.id} is ${st ?? 'still buried'} at midnight`);
      if (!c.found && st !== undefined) bad(`(n2) ${c.id} should have stayed buried, is ${st}`);
    }
  }
  if (emptySnapshot(map).chests.size) bad(`(n2) chests are already disturbed at t=0`);

  /* (r) town rivalries: narration, and nothing but narration.
   *
   * Four things are checked, and the third is the one that matters:
   *   - a day the seed did not call gets no wager lines at all;
   *   - a day it did gets at most RIVAL_LINES_MAX of them, in the only order
   *     a wager can happen in, and all of them about the two towns named;
   *   - the BUILT WORLD is bit-for-bit the same with the wager lines deleted.
   *     If a rivalry ever moves a nail, this is what catches it;
   *   - and the alehouse the loser pays up in is a building that exists, in a
   *     rival town, of a kind you could stand a round in. No invented pubs.
   */
  const riv = rivalryOf(map);
  const rivLines = ev.filter((e) => e.type === 'log' && rivalTag(e.text));
  const rivTags = rivLines.map((e) => rivalTag(e.text));
  if (!riv) {
    if (rivLines.length)
      bad(`(r) ${rivLines.length} wager line(s) on a day the seed called no rivalry`);
  } else {
    const both = new Set([riv.a.id, riv.b.id]);
    if (rivLines.length > RIVAL_LINES_MAX)
      bad(`(r) ${rivLines.length} wager lines, cap is ${RIVAL_LINES_MAX}`);
    for (const l of rivLines)
      if (!both.has(l.siteId))
        bad(`(r) wager line about ${l.siteId ?? 'nobody'}, rivals are ${[...both].join('/')}`);
    if (rivTags.length && rivTags[0] !== 'challenge')
      bad(`(r) the ledger opens the wager with a "${rivTags[0]}" line`);
    if (rivTags.filter((t) => t === 'challenge').length > 1)
      bad(`(r) the wager is laid more than once`);
    const isResult = (t) => t === 'settle' || t === 'close';
    const isPaid = (t) => t === 'pubNew' || t === 'pubStanding' || t === 'nopub';
    const resultAt = rivTags.findIndex(isResult);
    const paidAt = rivTags.findIndex(isPaid);
    if (rivTags.filter(isResult).length > 1) bad(`(r) the race is settled twice`);
    if (rivTags.filter(isPaid).length > 1) bad(`(r) the bet is paid twice`);
    if ((resultAt < 0) !== (paidAt < 0))
      bad(`(r) a result with no reckoning, or a reckoning with no result`);
    if (resultAt >= 0 && paidAt < resultAt) bad(`(r) the bet is paid before it is lost`);
    rivTags.forEach((t, i) => {
      if ((t === 'score' || t === 'level') && resultAt >= 0 && i > resultAt)
        bad(`(r) a running score after the race was already settled`);
    });

    // the wager, deleted: the world must not notice
    if (rivLines.length) {
      const without = { events: ev.filter((e) => !(e.type === 'log' && rivalTag(e.text))) };
      for (const at of [8, 16, 24]) {
        const a = serialize(snapshotAt(map, tl, at), false);
        const b = serialize(snapshotAt(map, without, at), false);
        if (a !== b) bad(`(r) deleting the wager lines changes the world at ${hhmm(at)}`);
      }
    }

    // the alehouse is never invented
    for (let i = 0; i < rivLines.length; i++) {
      if (rivTags[i] !== 'pubNew' && rivTags[i] !== 'pubStanding') continue;
      let found = null;
      for (const s of map.sites) {
        if (!both.has(s.id)) continue;
        for (const b of s.buildings) if (rivLines[i].text.includes(b.label)) found = b;
      }
      if (!found) bad(`(r) the bet is settled in a building no rival town ever built`);
      else if (!RIVAL_PUB_ROLES.has(found.role))
        bad(`(r) the bet is settled in a ${found.role}, which is not somewhere to drink`);
    }
  }

  /* (k) day arc: first road mid-morning, ledger well spread, quiet close */
  const roadEvents = ev.filter((e) => e.type === 'road');
  const firstRoad = roadEvents.length ? roadEvents[0].t : null;
  if (full && firstRoad !== null && firstRoad < 6)
    bad(`(k) first road at ${hhmm(firstRoad)} — too early for a mid-morning push`);
  const logs = ev.filter((e) => e.type === 'log');
  if (full) {
    // A wager day is allowed to run a few lines long — exactly as many as the
    // rivalry pass is capped at, and not one more.
    const room = 45 + (riv ? RIVAL_LINES_MAX : 0);
    if (logs.length < 25 || logs.length > room)
      bad(`(k) ${logs.length} log lines, want 25..${room}`);
    if (!logs.some((l) => l.t > 22)) bad(`(k) nothing in the ledger after 22:00`);
    // no six-hour dead patch in the ledger
    let prevLog = 0;
    for (const l of logs) {
      if (l.t - prevLog > 4.5) bad(`(k) ledger gap ${hhmm(prevLog)} -> ${hhmm(l.t)}`);
      prevLog = l.t;
    }
  }

  /* --- report ----------------------------------------------------------- */
  const byType = {};
  for (const e of ev) byType[e.type] = (byType[e.type] ?? 0) + 1;

  // how often is there visibly something happening?
  let live = 0;
  const probe = emptySnapshot(map);
  const SAMPLES = 96;
  for (let i = 1; i <= SAMPLES; i++) {
    advance(probe, tl, (i / SAMPLES) * 24);
    const busy =
      [...probe.buildings.values()].some((b) => b.status === 'building') ||
      [...probe.trees.values()].some((v) => v === 'felling');
    if (busy) live++;
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${fails.length ? 'FAIL' : 'PASS'}  ${label}${full ? '' : `   [pace ${pace}]`}`);
  console.log(
    `  sites ${map.sites.length}  buildings ${buildingById.size}  roads ${map.roads.length}  ` +
      `bridges ${map.bridges.length}  fords ${(map.fords ?? []).length}  trees ${map.trees.length} ` +
      `(plot ${plotClears.size} / route ${roadClears.size} / wild ${map.trees.length - clearable.size})`,
  );
  console.log(
    `  events ${ev.length}   first road ${firstRoad === null ? '--' : hhmm(firstRoad)}   ` +
      `last build ${hhmm(lastBuild)}   last event ${hhmm(ev[ev.length - 1]?.t ?? 0)}   ` +
      `something-underway ${Math.round((live / SAMPLES) * 100)}% of the day`,
  );
  console.log(
    '  by type: ' +
      Object.entries(byType)
        .sort()
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
  );
  const foundLine = [...foundT.entries()].map(([k, v]) => `${k}@${hhmm(v)}`).join(' ');
  if (foundLine) console.log(`  foundings: ${foundLine}`);
  if (chests.length) {
    console.log(
      `  chests: ` +
        chests
          .map(
            (c) =>
              `${c.id}/${c.reward}${c.grantIds.length ? `x${c.grantIds.length}` : ''}` +
              (discT.has(c.id) ? `@${hhmm(discT.get(c.id))}` : c.found ? '@NEVER' : ' buried')
          )
          .join('  ')
    );
  }
  if (riv) {
    console.log(
      `  rivalry: ${riv.a.name} (${riv.a.id}) v ${riv.b.name} (${riv.b.id})   ` +
        `${rivLines.length} line${rivLines.length === 1 ? '' : 's'} [${rivTags.join(' ')}]`,
    );
  }
  for (const m of fails) console.log(`  ! ${m}`);
  return { fails, ev, tl, map, lastBuild, pace, riv, rivLines, rivTags };
}

function sampleLogs(ev, n = 8) {
  const logs = ev.filter((e) => e.type === 'log');
  const out = [];
  for (let i = 0; i < n && logs.length; i++) {
    const idx = Math.min(logs.length - 1, Math.round(((i + 0.5) / n) * logs.length));
    out.push(logs[idx]);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

const cases = [];

cases.push([
  'fixture: 3 sites / bridge / loop road / 6 route trees per road',
  makeFixture(hashSeed('2026-08-02'), {
    buildings: [4, 3, 3],
    trees: 60,
    loopRoad: true,
    roadClears: 6,
  }),
]);
// deliberately no `clears` on the roads at all — the optional path
cases.push(['fixture: 2 sites, tiny, no road clears', makeFixture(1234, { buildings: [2, 1], trees: 20 })]);
cases.push([
  'fixture: 3 sites, bridge at the start of the road',
  makeFixture(99, { buildings: [3, 4, 2], trees: 60, bridgeAt: 0.05, roadClears: 6 }),
]);
cases.push([
  'fixture: 3 sites, bridge at the end of the road',
  makeFixture(777, { buildings: [3, 3, 4], trees: 60, bridgeAt: 0.97, roadClears: 8 }),
]);
// Fords. The road must NOT stop for these, which is the whole of (e2).
cases.push([
  'fixture: 3 sites, a track that fords instead of bridging',
  makeFixture(31337, { buildings: [3, 3, 3], trees: 60, roadClears: 6, fords: [{ road: 0, at: 0.45 }] }),
]);
cases.push([
  'fixture: ford early on one road, bridge on the next, ford on the loop',
  makeFixture(2718, {
    buildings: [3, 4, 3],
    trees: 80,
    roadClears: 8,
    loopRoad: true,
    bridgeAt: 0.6,
    fords: [{ road: 0, at: 0.08 }, { road: 'loop', at: 0.9 }],
  }),
]);
cases.push([
  'fixture: two fords on the same track',
  makeFixture(161803, {
    buildings: [4, 3, 3],
    trees: 70,
    roadClears: 6,
    fords: [{ road: 1, at: 0.3 }, { road: 1, at: 0.72 }],
  }),
]);
cases.push([
  'fixture: dense forest — 12 plot clears, 14 route trees per road',
  makeFixture(4242, {
    buildings: [5, 5, 4],
    trees: 150,
    plotClears: 13,
    roadClears: 14,
    loopRoad: true,
  }),
]);
cases.push([
  'fixture: big — 5 sites, 30 buildings',
  makeFixture(5150, { buildings: [7, 6, 6, 6, 5], trees: 180, loopRoad: true, roadClears: 10 }),
]);
cases.push(['fixture: one site only', makeFixture(31337, { buildings: [5], trees: 18 })]);
cases.push([
  'fixture: a coin hoard and a charter, both found',
  makeFixture(60613, {
    buildings: [5, 5, 4],
    trees: 90,
    roadClears: 6,
    chests: [
      { reward: 'coin', site: 1, found: true, grants: 2 },
      { reward: 'charter', site: 2, found: true, grants: 1 },
    ],
  }),
]);
cases.push([
  'fixture: chests nobody finds, and a trinket somebody does',
  makeFixture(60614, {
    buildings: [4, 4],
    trees: 60,
    chests: [
      { reward: 'coin', site: 1, found: false, grants: 2 },
      { reward: 'trinket', site: 1, found: true },
    ],
  }),
]);
/* ---- town rivalries (additive) ------------------------------------------ *
 * Three shapes, chosen by rolling the rivalry substream by hand: a seed that
 * calls a race between towns big enough to have one, the same shape on a seed
 * that does not, and a pair too small to qualify (two roofs a town) so the
 * ≥3-roof floor is exercised on a seed that WOULD otherwise have said yes.
 * -------------------------------------------------------------------------- */
cases.push([
  'fixture: a rivalry — three towns, six roofs each',
  makeFixture(26, { buildings: [7, 6, 6], trees: 90, roadClears: 6, loopRoad: true }),
]);
cases.push([
  'fixture: the same shape on a seed with no rivalry in it',
  makeFixture(3, { buildings: [7, 6, 6], trees: 90, roadClears: 6, loopRoad: true }),
]);
cases.push([
  'fixture: a rivalry seed, but nobody is big enough to race',
  makeFixture(43, { buildings: [3, 2], trees: 30 }),
]);
/* ---- end town rivalries (additive) -------------------------------------- */

cases.push([
  // the pace control trimmed the reward out of the day: the find is real, the
  // windfall never arrives, and the ledger has to cope
  'fixture: a find whose reward is not in the map',
  makeFixture(60615, {
    buildings: [4, 3],
    trees: 40,
    chests: [{ reward: 'coin', site: 1, found: true, grants: 2, orphanGrant: true }],
  }),
]);

if (generateMap) {
  for (const day of ['2026-08-02', '2026-08-03', '2026-12-25', '2027-01-01']) {
    try {
      cases.push([`gen.ts seed ${day}`, generateMap(hashSeed(day))]);
    } catch (err) {
      console.log(`  (gen.ts threw for ${day}: ${err.message})`);
    }
  }
} else {
  console.log('gen.ts not present yet — running fixtures only.');
}

let failed = 0;
let total = 0;
let showcase = null;
let showcaseIsReal = false;
const pace1LastBuild = new Map();

for (const [label, map] of cases) {
  const r = run(label, map);
  total++;
  if (r.fails.length) failed++;
  pace1LastBuild.set(map, r.lastBuild);
  // prefer a real generated map for the flavour sample
  const real = label.startsWith('gen.ts');
  if (!showcase || (real && !showcaseIsReal)) {
    showcase = r;
    showcaseIsReal = real;
  }
}

/* -------------------------------------------------------------------------- */
/* pace — the same worlds at half and double the work rate                    */
/* -------------------------------------------------------------------------- */

// pace is clamped to [0.25, 4]
for (const [label, map] of cases.slice(0, 2)) {
  const lo = JSON.stringify(buildTimeline(map, 0.25).events);
  const hi = JSON.stringify(buildTimeline(map, 4).events);
  if (JSON.stringify(buildTimeline(map, 0.01).events) !== lo)
    (console.log(`\n! pace 0.01 not clamped to 0.25 for ${label}`), failed++);
  if (JSON.stringify(buildTimeline(map, 999).events) !== hi)
    (console.log(`\n! pace 999 not clamped to 4 for ${label}`), failed++);
  total += 2;
}

// buildTimeline(map, 1) must be indistinguishable from buildTimeline(map)
for (const [label, map] of cases) {
  const a = JSON.stringify(buildTimeline(map).events);
  const b = JSON.stringify(buildTimeline(map, 1).events);
  if (a !== b) {
    console.log(`\n! pace 1 is not identical to the single-argument call for ${label}`);
    failed++;
  }
  total++;
}

const withRoads = cases.filter(([, m]) => m.roads.length && m.sites.length > 1);
const realOnes = withRoads.filter(([l]) => l.startsWith('gen.ts'));
const dense = withRoads.filter(([l]) => l.startsWith('fixture: dense'));
const paceCases = [...withRoads.slice(0, 2), ...dense.slice(0, 1), ...realOnes.slice(0, 1)];
for (const [label, map] of paceCases) {
  for (const pace of [0.5, 2, 0.25, 4]) {
    const r = run(label, map, pace);
    total++;
    const extra = [];

    if (pace >= 1) {
      // faster work rate = the same day, 1/pace as far in, nothing lost
      const want = pace1LastBuild.get(map) / pace;
      if (Math.abs(r.lastBuild - want) > 0.02)
        extra.push(
          `(pace) last build ${hhmm(r.lastBuild)}, expected ~${hhmm(want)} (pace-1 time / ${pace})`,
        );
      if (r.ev[r.ev.length - 1].t >= 24) extra.push(`(pace) event past midnight survived`);
    } else {
      // half the work rate = the day runs out before the work does
      const end = snapshotAt(map, r.tl, 24);
      const unfinished = [...end.buildings.values()].filter((b) => b.status !== 'done');
      const partialRoads = map.roads.filter((rd) => (end.roads.get(rd.id) ?? 0) < 1);
      if (!unfinished.length) extra.push(`(pace) nothing left unfinished at pace ${pace}`);
      if (!partialRoads.length) extra.push(`(pace) no part-built road at pace ${pace}`);
      console.log(
        `  at midnight: ${unfinished.length}/${end.buildings.size} buildings unfinished, ` +
          `${partialRoads.length}/${map.roads.length} roads part-built, ` +
          `${end.founded.size}/${map.sites.length} sites founded`,
      );
    }

    for (const m of extra) console.log(`  ! ${m}`);
    if (extra.length) console.log(`  ^ FAIL (pace ${pace})`);
    if (r.fails.length || extra.length) failed++;
  }
}

if (showcase) {
  console.log(`\n${'='.repeat(72)}`);
  console.log('sample ledger — ' + showcase.map.valleyName);
  const snap0 = emptySnapshot(showcase.map);
  console.log(`  00:00  ${snap0.log[0].text}`);
  for (const l of sampleLogs(showcase.ev)) console.log(`  ${hhmm(l.t)}  ${l.text}`);

  console.log('\nfounding-event texts:');
  for (const e of showcase.ev) if (e.type === 'found') console.log(`  ${hhmm(e.t)}  ${e.text}`);

  console.log('\nsnapshot at 12:00:');
  const mid = snapshotAt(showcase.map, showcase.tl, 12);
  const done = [...mid.buildings.values()].filter((b) => b.status === 'done').length;
  const going = [...mid.buildings.values()].filter((b) => b.status === 'building').length;
  console.log(
    `  founded ${[...mid.founded].join(',')}  buildings done ${done} building ${going}  ` +
      `pop ${[...mid.population.entries()].map(([k, v]) => k + ':' + v).join(' ')}  ` +
      `stumps ${[...mid.trees.values()].filter((v) => v === 'stump').length}  ` +
      `props ${mid.props.size}  log ${mid.log.length}`,
  );
}

/* -------------------------------------------------------------------------- */
/* town rivalries (additive) — the wager is the same wager every time         */
/* -------------------------------------------------------------------------- */

console.log(`\n${'='.repeat(72)}`);
console.log('town rivalries');
{
  let rivFail = 0;
  const rbad = (m) => (console.log(`  ! ${m}`), rivFail++);

  /* (r1) the decision is a pure function of the map, and picks a real pair */
  for (const [label, map] of cases) {
    const one = rivalryOf(map);
    const two = rivalryOf(map);
    const key = (r) => (r ? `${r.a.id}/${r.b.id}/${r.mark}` : 'none');
    if (key(one) !== key(two)) rbad(`(r1) rivalryOf is not a function for ${label}`);
    if (!one) continue;
    const ids = new Set(map.sites.map((s) => s.id));
    if (!ids.has(one.a.id) || !ids.has(one.b.id) || one.a.id === one.b.id)
      rbad(`(r1) ${label}: rivals ${one.a.id}/${one.b.id} are not two towns on this map`);
    // both are big enough to have a race in them
    for (const s of [one.a, one.b]) {
      const roofs = s.buildings.length - (map.sites[0].id === s.id ? 1 : 0);
      if (roofs < 3) rbad(`(r1) ${label}: ${s.id} races with only ${roofs} roofs`);
    }
    // and where the roads join any qualifying pair at all, the rivals are one
    const joined = map.roads.some(
      (r) =>
        (r.from === one.a.id && r.to === one.b.id) || (r.from === one.b.id && r.to === one.a.id),
    );
    const anyJoined = map.roads.some((r) => {
      const A = map.sites.find((s) => s.id === r.from);
      const B = map.sites.find((s) => s.id === r.to);
      if (!A || !B || A === B) return false;
      const big = (s) => s.buildings.length - (map.sites[0].id === s.id ? 1 : 0) >= 3;
      return big(A) && big(B);
    });
    if (anyJoined && !joined)
      rbad(`(r1) ${label}: ${one.a.id}/${one.b.id} are strangers, and the roads offered neighbours`);
  }

  /* (r2) the same map, built twice, tells the same story word for word —
   *      including two maps generated separately from one seed */
  for (const [label, map] of cases) {
    if (!rivalryOf(map)) continue;
    const lines = (m) =>
      JSON.stringify(
        buildTimeline(m)
          .events.filter((e) => e.type === 'log' && rivalTag(e.text))
          .map((e) => [e.t, e.text, e.siteId]),
      );
    // two independent buildTimeline calls over the same map — not a tautology:
    // the rivalry pass draws from an rng, and a leaked one would show up here
    const first = lines(map);
    const second = lines(map);
    if (first !== second) rbad(`(r2) ${label}: wager lines are not deterministic`);
  }
  if (generateMap) {
    for (const day of ['2027-01-01', '2026-08-03']) {
      const a = generateMap(hashSeed(day));
      const b = generateMap(hashSeed(day));
      const lines = (m) =>
        JSON.stringify(
          buildTimeline(m)
            .events.filter((e) => e.type === 'log' && rivalTag(e.text))
            .map((e) => [e.t, e.text, e.siteId]),
        );
      if (lines(a) !== lines(b))
        rbad(`(r2) ${day}: two maps from one seed disagree about the wager`);
    }
  }

  /* (r3) a seed that says no says no at every pace, and says nothing */
  const quiet = cases.find(([l]) => l.startsWith('fixture: the same shape on a seed with no'));
  if (quiet) {
    for (const pace of [0.5, 1, 2, 4]) {
      const ev = buildTimeline(quiet[1], pace).events;
      const n = ev.filter((e) => e.type === 'log' && rivalTag(e.text)).length;
      if (n) rbad(`(r3) ${n} wager lines at pace ${pace} on a seed with no rivalry`);
    }
  }
  const small = cases.find(([l]) => l.startsWith('fixture: a rivalry seed, but nobody'));
  if (small && rivalryOf(small[1]))
    rbad(`(r3) a two-roof hamlet was allowed into a race`);

  /* (r4) how often, over a real sweep — a guard on RIVALRY_CHANCE itself */
  if (generateMap) {
    let multi = 0;
    let riv = 0;
    let lines = 0;
    let capped = 0;
    for (let s = 1; s <= 120; s++) {
      const map = generateMap((s * 2654435761) >>> 0);
      if (map.sites.length >= 2) multi++;
      const r = rivalryOf(map);
      if (!r) continue;
      riv++;
      const n = buildTimeline(map).events.filter((e) => e.type === 'log' && rivalTag(e.text)).length;
      lines += n;
      if (n > RIVAL_LINES_MAX) capped++;
      if (!n) rbad(`(r4) seed ${(s * 2654435761) >>> 0}: a rivalry that never reached the ledger`);
    }
    const pct = (100 * riv) / Math.max(1, multi);
    console.log(
      `  ${riv}/${multi} multi-town seeds run a wager (${pct.toFixed(1)}%), ` +
        `${(lines / Math.max(1, riv)).toFixed(2)} ledger lines each`,
    );
    if (pct < 18 || pct > 42) rbad(`(r4) ${pct.toFixed(1)}% of days are races — want roughly 1 in 4`);
    if (capped) rbad(`(r4) ${capped} days ran past the ${RIVAL_LINES_MAX}-line cap`);
  }

  console.log(`  ${rivFail ? `${rivFail} RIVALRY CHECKS FAILED` : 'rivalry checks all pass'}`);
  failed += rivFail;
  total += 4;
}

/* -------------------------------------------------------------------------- */
/* pacing across map scales, with dense clears throughout                     */
/* -------------------------------------------------------------------------- */

console.log(`\n${'='.repeat(72)}`);
console.log('pacing sweep — last roof must land in 20:24..22:00 at every map scale');
const shapes = [
  ['1 site,  4 buildings', [4]],
  ['2 sites, 7 buildings', [4, 3]],
  ['3 sites, 14 buildings', [5, 5, 4]],
  ['4 sites, 22 buildings', [7, 5, 5, 5]],
  ['5 sites, 30 buildings', [7, 6, 6, 6, 5]],
  ['6 sites, 42 buildings', [8, 7, 7, 7, 7, 6]],
  ['7 sites, 56 buildings', [8, 8, 8, 8, 8, 8, 8]],
];
let sweepFail = 0;
for (const [name, buildings] of shapes) {
  const nb = buildings.reduce((a, b) => a + b, 0);
  const m = makeFixture(hashSeed(name), {
    buildings,
    trees: Math.max(60, nb * 30),
    plotClears: 13,
    roadClears: 14,
    loopRoad: buildings.length >= 3,
  });
  const tl = buildTimeline(m);
  const bs = tl.events.filter((e) => e.type === 'build');
  const last = bs.length ? bs[bs.length - 1].t : 0;
  const chops = tl.events.filter((e) => e.type === 'chop-done').length;
  const ok = last >= 20.4 && last <= 22.0;
  if (!ok) sweepFail++;
  console.log(
    `  ${ok ? 'ok  ' : 'BAD '} ${name.padEnd(22)} last roof ${hhmm(last)}   ` +
      `${tl.events.length} events, ${chops} trees felled`,
  );
}
if (sweepFail) failed += sweepFail;
total += shapes.length;

/* -------------------------------------------------------------------------- */
/* road-cutting detail: does the head visibly slow through the wood?          */
/* -------------------------------------------------------------------------- */

{
  const [, m] = cases.find(([l]) => l.startsWith('fixture: dense'));
  const tl = buildTimeline(m);
  // the road with the most trees on it
  const road = m.roads.reduce((best, r) =>
    (r.clears?.length ?? 0) > (best?.clears?.length ?? 0) ? r : best, null);
  if (road) {
    const steps = tl.events.filter((e) => e.type === 'road' && e.roadId === road.id);
    const cl = road.clears;
    console.log(`\n${'='.repeat(72)}`);
    console.log(`road ${road.id} (${road.kind}), ${cl.length} trees on the route`);
    let prev = null;
    for (const e of steps) {
      const n = cl.filter((c) => c.frac <= e.frac && (!prev || c.frac > prev.frac)).length;
      const mins = prev ? Math.round((e.t - prev.t) * 60) : 0;
      console.log(
        `  frac ${e.frac.toFixed(3)}  ${hhmm(e.t)}` +
          (prev ? `  +${String(mins).padStart(3)} min` : '        ') +
          (n ? `   ${'|'.repeat(n)} ${n} tree${n > 1 ? 's' : ''} felled in this stretch` : ''),
      );
      prev = e;
    }
  }
}

/* ========================================================================== */
/* THE DAY-TYPE LOTTERY                                                       */
/* -------------------------------------------------------------------------- *
 * The lottery is APPEND-ONLY, and that promise is the archive's: a valley
 * browsed a year ago has to still be the day it was. Nothing else in the
 * codebase can enforce that, because the failure mode is a *diff* — somebody
 * inserts a row into TABLE, every boundary below it shifts, and thousands of
 * days silently become different days with no test going red anywhere.
 *
 * So the harness carries its own copy of the table, as a ledger. Two things
 * come out of it:
 *
 *   the CURRENT table must match the ledger    (a row moved, or a probability
 *                                               changed, and nobody said so)
 *   EVERY PREFIX of the ledger must agree      (the append-only property
 *     with the whole ledger about every seed    itself, proved from the table
 *     that prefix assigns                       rather than from stored data)
 *
 * The second is the load-bearing one, and it is why the ledger is written as a
 * list rather than as a set: walk the first k rows, and every seed that lands
 * on a type must land on the SAME type under all n. That is true of an appended
 * row and false of an inserted one, for any k at all.
 * ========================================================================== */

const {
  dayTypeOf,
  dayInfo,
  mistAt,
  eclipseAt,
  stormAt,
  auroraAt,
  starsAt,
  stormWarp,
  workPace,
  riverMood,
  CALM_RIVER,
} = await import(join(gdir, 'daytype.ts'));

console.log(`\n${'='.repeat(72)}`);
console.log('day-type lottery');

/**
 * The ledger. Rows in the order they were appended, ever. ADD TO THE END ONLY;
 * if you find yourself editing a line above the last one, the thing you are
 * about to do rewrites days that already happened.
 */
const DAY_LEDGER = [
  ['mist', 0.06],
  ['storm', 0.06],
  ['aurora', 0.05],
  ['eclipse', 0.03],
  ['market', 0.035],
  ['stars', 0.033],
  ['flood', 0.033],
  ['drought', 0.033],
];
/** Every type the module can answer with, plus the one it answers with most. */
const ALL_DAYS = ['normal', ...DAY_LEDGER.map(([k]) => k)];
const SALT_TYPE = 0xda7c0de1;
const DAY_N = 20000;

/** The type a table of `rows` gives a seed, walked exactly as daytype.ts walks it. */
function typeFrom(rows, seed) {
  const roll = mulberry32(((seed >>> 0) ^ SALT_TYPE) >>> 0)();
  let acc = 0;
  for (const [k, p] of rows) {
    acc += p;
    if (roll < acc) return k;
  }
  return 'normal';
}

/* ---- (day-a) the module's table is the ledger's table --------------------- */
{
  const bad = [];
  for (let s = 1; s <= DAY_N && bad.length < 6; s++) {
    const want = typeFrom(DAY_LEDGER, s);
    const got = dayTypeOf(s).type;
    if (want !== got) bad.push(`seed ${s}: ledger says ${want}, daytype.ts says ${got}`);
  }
  total++;
  if (bad.length) {
    failed++;
    console.log('\n! (day-a) daytype.ts TABLE does not match the harness ledger');
    for (const b of bad) console.log(`    ${b}`);
  } else {
    console.log(`  (day-a) ok   table matches the ledger over ${DAY_N} seeds`);
  }
}

/* ---- (day-b) every prefix agrees: the append-only proof ------------------- */
{
  const bad = [];
  for (let k = 1; k < DAY_LEDGER.length; k++) {
    const prefix = DAY_LEDGER.slice(0, k);
    for (let s = 1; s <= DAY_N; s++) {
      const was = typeFrom(prefix, s);
      if (was === 'normal') continue; // a `normal` seed is allowed to be claimed
      const now = dayTypeOf(s).type;
      if (was !== now) {
        bad.push(`prefix of ${k}: seed ${s} was ${was}, is now ${now}`);
        break;
      }
    }
  }
  total++;
  if (bad.length) {
    failed++;
    console.log('\n! (day-b) the lottery is NOT append-only — a row was inserted or re-weighted');
    for (const b of bad) console.log(`    ${b}`);
  } else {
    console.log(
      `  (day-b) ok   all ${DAY_LEDGER.length - 1} prefixes agree with the whole table ` +
        `(append-only, ${DAY_N} seeds each)`
    );
  }
}

/* ---- (day-c) how often each kind of day actually turns up ---------------- */
{
  const counts = Object.fromEntries(ALL_DAYS.map((k) => [k, 0]));
  for (let s = 1; s <= DAY_N; s++) counts[dayTypeOf(s).type]++;
  const bad = [];
  for (const [k, p] of DAY_LEDGER) {
    const rate = counts[k] / DAY_N;
    // Wide enough that sampling noise never fails it, tight enough that a
    // mis-typed probability does.
    if (Math.abs(rate - p) > Math.max(0.006, p * 0.16)) {
      bad.push(`${k}: ${(rate * 100).toFixed(2)}% over ${DAY_N} seeds, table says ${(p * 100).toFixed(1)}%`);
    }
  }
  const special = DAY_N - counts.normal;
  console.log(
    `  (day-c) ${bad.length ? 'BAD ' : 'ok  '} rates over ${DAY_N} seeds: ` +
      DAY_LEDGER.map(([k]) => `${k} ${((counts[k] / DAY_N) * 100).toFixed(2)}%`).join(', ')
  );
  console.log(
    `           ordinary ${((counts.normal / DAY_N) * 100).toFixed(1)}%, ` +
      `something ${((special / DAY_N) * 100).toFixed(1)}% (1 day in ${(DAY_N / special).toFixed(1)})`
  );
  total++;
  if (bad.length) {
    failed++;
    for (const b of bad) console.log(`    ! ${b}`);
  }
}

/* ---- (day-d) three draws, on every branch, for every type ---------------- *
 * `dayTypeOf` takes exactly three numbers off its stream — the roll, and the
 * two the window is shaped from — and a new type that reaches for a fourth
 * would move the windows of every type that follows it in the switch. Proved
 * functionally rather than by reading the source: if a type's window really is
 * built out of draws 2 and 3, then `from` is affine in draw 2 and `to` is
 * affine in (draw 2, draw 3). Fit the coefficients off the first few seeds of
 * that type and every remaining seed of that type must land on them. */
{
  const draws = (seed) => {
    const r = mulberry32(((seed >>> 0) ^ SALT_TYPE) >>> 0);
    r();
    return [r(), r()];
  };
  const byType = Object.fromEntries(ALL_DAYS.map((k) => [k, []]));
  for (let s = 1; s <= DAY_N; s++) {
    const d = dayTypeOf(s);
    const [a, b] = draws(s);
    byType[d.type].push([a, b, d.from, d.to]);
  }
  /** Solve for the plane z = c0 + c1*a + c2*b through three samples. */
  const solve3 = (rows, zi) => {
    const [p, q, r] = rows;
    const A = [
      [1, p[0], p[1], p[zi]],
      [1, q[0], q[1], q[zi]],
      [1, r[0], r[1], r[zi]],
    ];
    for (let c = 0; c < 3; c++) {
      let piv = c;
      for (let i = c + 1; i < 3; i++) if (Math.abs(A[i][c]) > Math.abs(A[piv][c])) piv = i;
      if (Math.abs(A[piv][c]) < 1e-12) return null;
      [A[c], A[piv]] = [A[piv], A[c]];
      for (let i = 0; i < 3; i++) {
        if (i === c) continue;
        const f = A[i][c] / A[c][c];
        for (let j = c; j < 4; j++) A[i][j] -= f * A[c][j];
      }
    }
    return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
  };
  const bad = [];
  for (const k of ALL_DAYS) {
    const rows = byType[k];
    if (k === 'normal' || rows.length < 8) continue;
    for (const [zi, label] of [
      [2, 'from'],
      [3, 'to'],
    ]) {
      const c = solve3(rows.slice(0, 3), zi);
      if (!c) continue; // degenerate sample; the other field still checks it
      let worst = 0;
      for (const row of rows) {
        const want = c[0] + c[1] * row[0] + c[2] * row[1];
        worst = Math.max(worst, Math.abs(want - row[zi]));
      }
      if (worst > 1e-9) bad.push(`${k}.${label} is not affine in the two window draws (off by ${worst})`);
    }
  }
  total++;
  if (bad.length) {
    failed++;
    console.log('\n! (day-d) dayTypeOf does not take exactly three draws on every branch');
    for (const b of bad) console.log(`    ${b}`);
  } else {
    console.log('  (day-d) ok   every window is affine in draws 2 and 3 — the draw count is fixed at 3');
  }
}

/* ---- (day-e) one warp, one phenomenon each ------------------------------- *
 * Storm's `stormWarp` is the ONE time warp in the codebase and there must never
 * be a second: two warps on one day would compose into a shape the pacing
 * solver never solved for, and the last roof would stop landing where it was
 * put. So every other day type — including the three presentation days — must
 * be the identity on time and on the work rate. And each intensity curve must
 * answer for its own day and no other, or a flood day would come out foggy. */
{
  const bad = [];
  const seen = new Set();
  const grid = [];
  for (let t = 0; t <= 24.0001; t += 0.05) grid.push(Number(t.toFixed(2)));
  const curves = { mist: mistAt, eclipse: eclipseAt, storm: stormAt, aurora: auroraAt, stars: starsAt };
  for (let s = 1; s <= DAY_N && seen.size < ALL_DAYS.length; s++) {
    const day = dayInfo(s, null);
    if (seen.has(day.type)) continue;
    seen.add(day.type);
    for (const t of grid) {
      if (day.type !== 'storm') {
        if (stormWarp(day, t) !== t) bad.push(`${day.type} (seed ${s}) warps time at ${t}`);
        if (workPace(day, t) !== 1) bad.push(`${day.type} (seed ${s}) changes the work rate at ${t}`);
      }
      for (const [k, fn] of Object.entries(curves)) {
        if (k === day.type) continue;
        if (fn(day, t) !== 0) bad.push(`${day.type} (seed ${s}) makes ${k}At non-zero at ${t}`);
      }
      if (bad.length > 5) break;
    }
  }
  total++;
  if (bad.length) {
    failed++;
    console.log('\n! (day-e) a day type reached outside its own lane');
    for (const b of bad.slice(0, 6)) console.log(`    ${b}`);
  } else {
    console.log(
      `  (day-e) ok   storm is still the only time warp; each curve answers only for its own day ` +
        `(${seen.size} types × ${grid.length} hours)`
    );
  }
}

/* ---- (day-f) flood and drought are BAKE-TIME AND NARRATION ONLY ---------- *
 * The whole of their world-visible effect is `riverMood`, which the scene reads
 * once when it bakes the terrain. On every other day it must hand back exact
 * ones — that is what makes every river in the archive byte-identical to the
 * river it was before flood and drought existed, by arithmetic rather than by
 * anybody remembering to test it. And `gen.ts` must never learn any of this:
 * a map that knew what kind of day it was would be a different valley on a
 * flood day, which is precisely the thing that was ruled out. */
{
  const bad = [];
  const seen = new Set();
  for (let s = 1; s <= DAY_N && seen.size < ALL_DAYS.length; s++) {
    const day = dayInfo(s, null);
    if (seen.has(day.type)) continue;
    seen.add(day.type);
    const m = riverMood(day);
    if (day.type === 'flood' || day.type === 'drought') {
      if (m.kind !== day.type) bad.push(`${day.type} does not ask for its own river treatment`);
      if (m.water === 1 && m.bank === 1) bad.push(`${day.type} paints an ordinary river`);
    } else if (m.water !== 1 || m.bank !== 1 || m.foam !== 1 || m.kind !== null) {
      bad.push(`${day.type} is not the identity river: ${JSON.stringify(m)}`);
    }
  }
  if (CALM_RIVER.water !== 1 || CALM_RIVER.bank !== 1 || CALM_RIVER.foam !== 1 || CALM_RIVER.kind !== null) {
    bad.push('CALM_RIVER is not the identity');
  }
  // ...and the generator has never heard of any of it.
  const genSrc = readFileSync(join(gdir, 'gen.ts'), 'utf8');
  if (/daytype|dayTypeOf|riverMood|DayInfo/.test(genSrc)) {
    bad.push('gen.ts references the day type — the map must not know what kind of day it is');
  }
  total++;
  if (bad.length) {
    failed++;
    console.log('\n! (day-f) flood/drought are not presentation-only');
    for (const b of bad) console.log(`    ${b}`);
  } else {
    console.log(
      '  (day-f) ok   riverMood is the identity on every ordinary day, and gen.ts has never heard of day types'
    );
  }
}

/* ---- (day-g) the three new days on real worlds --------------------------- *
 * End to end: build the actual timeline of an actual generated valley on each
 * of the three new days, and check that all that happened is that the ledger
 * gained lines. The last roof still has to land inside the pacing window — a
 * day that quietly warped time would miss it — and the lines have to be inside
 * the hours the day type declared. */
if (generateMap) {
  const wanted = ['stars', 'flood', 'drought'];
  const picks = [];
  for (let s = 1; s < 400 && picks.length < wanted.length; s++) {
    const d = dayTypeOf(s);
    if (wanted.includes(d.type) && !picks.some((p) => p.type === d.type)) picks.push({ seed: s, ...d });
  }
  for (const p of picks) {
    const map = generateMap(p.seed);
    const tl = buildTimeline(map);
    const builds = tl.events.filter((e) => e.type === 'build');
    const last = builds.length ? builds[builds.length - 1].t : 0;
    // The lines this day type wrote, found by the hours they were placed at.
    const wantN = p.type === 'stars' ? 1 : 2;
    const at = p.type === 'stars' ? [p.from + 0.5] : [p.from + 0.22, p.to + 0.18];
    const lines = tl.events.filter(
      (e) => e.type === 'log' && at.some((h) => Math.abs(e.t - h) < 1e-9)
    );
    const extra = [];
    if (lines.length !== wantN) extra.push(`${lines.length} ledger lines at the declared hours, expected ${wantN}`);
    if (!(last >= 20.4 && last <= 22.0)) extra.push(`last roof ${hhmm(last)} — outside the pacing window`);
    // No new event TYPE: a presentation day writes logs and nothing else.
    const kinds = new Set(tl.events.map((e) => e.type));
    for (const k of kinds) {
      if (!['found', 'arrive', 'chop-start', 'chop-done', 'survey', 'build', 'road', 'bridge', 'ford', 'prop', 'dig', 'discover', 'log'].includes(k)) {
        extra.push(`unknown event type ${k}`);
      }
    }
    total++;
    if (extra.length) {
      failed++;
      console.log(`\n! (day-g) ${p.type} day, seed ${p.seed}`);
      for (const e of extra) console.log(`    ${e}`);
    } else {
      console.log(
        `  (day-g) ok   ${p.type.padEnd(7)} seed ${String(p.seed).padEnd(4)} ` +
          `last roof ${hhmm(last)}, ${lines.length} ledger line${lines.length > 1 ? 's' : ''}`
      );
      for (const l of lines) console.log(`             ${hhmm(l.t)}  ${l.text}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* living details II — hay, timber, and same t + same seed = same world       */
/* -------------------------------------------------------------------------- */
/*
 * The three details of this wave are drawn by scene.ts but DECIDED by
 * living.ts, which is a pure function of the map, the plan and `t` — no new
 * event type, no new snapshot field, nothing ambient. That is what is checked
 * here, on the real generated worlds as well as the fixtures:
 *
 *   growth is MONOTONE      hay only ever gets taller, and so does a timber
 *                           pile, because the count it is made of only ever
 *                           grows. A detail that goes backwards as the day
 *                           runs forwards is the whole failure mode.
 *   placement REPLAYS       the same map gives the same ricks in the same
 *                           places with the same clocks, every call.
 *   the same t is the same world  the state at 17:00 reached by scrubbing and
 *                           the state at 17:00 reached by playing are byte for
 *                           byte the same string — which is the property the
 *                           paused A/B screenshot harness rests on.
 */
{
  console.log(`\n${'='.repeat(72)}`);
  console.log('living details II — leaning trees, haystacks, lumber piles');

  /** Everything the three details would draw at this snapshot, as one string. */
  const livingAt = (tl, snap, hayPlans, reachById) => {
    const parts = [];
    for (const [id, cd] of chopDoneTimes(tl)) {
      const ph = leanPhase(cd, snap.t);
      // the renderer's own gate: only a tree the snapshot calls felling leans
      if (ph >= 0 && snap.trees.get(id) === 'felling') parts.push(`L${id}:${ph.toFixed(9)}`);
    }
    hayPlans.forEach((h, i) => {
      parts.push(`H${i}:${snap.props.has(h.propId) ? hayStage(snap.t, h.at) : -1}`);
    });
    for (const [id, reach] of reachById) {
      parts.push(`P${id}:${snap.props.has(id) ? pileStage(reach, snap.felled ?? new Map()) : -1}`);
    }
    return parts.join('|');
  };

  let hayTotal = 0;
  let pileTotal = 0;
  for (const [label, map] of cases) {
    const fails = [];
    const bad = (m) => fails.push(m);
    const tl = buildTimeline(map);
    const doomed = doomedTrees(map);
    const reachById = pileReach(map, doomed);
    const propById = new Map();
    for (const s of map.sites) for (const p of s.props) propById.set(p.id, p);

    /* --- the hay ---------------------------------------------------------- */
    const hayPlans = [];
    for (const s of map.sites) {
      for (const p of s.props) {
        const plans = hayFor(s, p);
        if (JSON.stringify(hayFor(s, p)) !== JSON.stringify(plans))
          bad(`hayFor(${p.id}) is not a function of its arguments`);
        let prev = -Infinity;
        for (const h of plans) {
          if (h.propId !== p.id) bad(`hay off ${p.id} gated on ${h.propId}`);
          if (!(h.at >= 15 && h.at <= 21)) bad(`hay off ${p.id} cut at ${hhmm(h.at)} — not an afternoon`);
          if (!(h.at > prev)) bad(`hay off ${p.id} out of order: ${hhmm(h.at)} after ${hhmm(prev)}`);
          prev = h.at;
          const d = Math.hypot(h.gx - p.gx, h.gy - p.gy);
          if (d > 3) bad(`hay off ${p.id} stands ${d.toFixed(1)} tiles away — that is not its field`);
          // three ages, in order, each of them arrived at once and never left
          if (hayStage(h.at - 1e-9, h.at) !== -1) bad(`hay off ${p.id} exists before it is cut`);
          if (hayStage(h.at, h.at) !== 0) bad(`hay off ${p.id} does not start as a heap`);
          if (hayStage(24, h.at) !== 2) bad(`hay off ${p.id} is still not a rick at midnight`);
          let last = -1;
          for (let t = 0; t <= 24.0001; t += 0.02) {
            const st = hayStage(t, h.at);
            if (st < last) bad(`hay off ${p.id} shrank at ${hhmm(t)}`);
            last = st;
          }
          hayPlans.push(h);
        }
        // only a field or a rick grows hay, and a field only in a farming town
        if (plans.length && p.kind !== 'haystack' && p.kind !== 'crop')
          bad(`${p.kind} ${p.id} grew hay`);
        if (plans.length && p.kind === 'crop' && s.profession !== 'farming')
          bad(`a ${s.profession ?? 'plain'} town's field at ${p.id} grew hay`);
      }
    }
    hayTotal += hayPlans.length;

    /* --- the timber ------------------------------------------------------- */
    for (const [id, reach] of reachById) {
      if (propById.get(id)?.kind !== 'lumber') bad(`${id} has a reach but is not a timber yard`);
      for (const t of reach) if (!doomed.has(t)) bad(`${id} counts ${t}, which nobody fells`);
      if (pileStage(reach, new Map()) !== (reach.length ? 0 : 1))
        bad(`${id} does not start at the bottom`);
    }
    pileTotal += reachById.size;

    /* --- monotone over the whole day, and the same t twice ---------------- */
    const walk = emptySnapshot(map);
    const seen = new Map();
    let prevPile = new Map();
    for (let t = 0; t <= 24.0001; t += 0.25) {
      const at = Math.min(t, 24);
      advance(walk, tl, at);
      for (const [id, reach] of reachById) {
        const st = pileStage(reach, walk.felled ?? new Map());
        if (st < (prevPile.get(id) ?? 0)) bad(`${id}: the pile shrank at ${hhmm(at)}`);
        prevPile.set(id, st);
      }
      if (Math.abs(at - Math.round(at)) < 1e-9) seen.set(at, livingAt(tl, walk, hayPlans, reachById));
    }
    // the same hour, arrived at from a standing start rather than walked to
    for (const [at, want] of seen) {
      const got = livingAt(tl, snapshotAt(map, tl, at), hayPlans, reachById);
      if (got !== want) bad(`${hhmm(at)}: scrubbed world != played world`);
    }
    // …and every pile full by the end of a day that finishes its felling
    for (const [id, reach] of reachById) {
      if (reach.length >= 6 && pileStage(reach, walk.felled ?? new Map()) !== 2)
        bad(`${id}: ${reach.length} trees came down within reach and the yard is not full`);
    }

    total++;
    if (fails.length) failed++;
    console.log(
      `  ${fails.length ? 'FAIL' : 'ok  '} ${label.padEnd(58)} ` +
        `hay ${String(hayPlans.length).padStart(3)}  yards ${String(reachById.size).padStart(2)}`
    );
    for (const m of fails) console.log(`    ! ${m}`);
  }
  if (!hayTotal) (console.log('  ! not one haystack in any world'), failed++);
  if (!pileTotal) (console.log('  ! not one timber yard in any world'), failed++);
  total += 2;
}

console.log(`\n${failed ? `${failed}/${total} CASES FAILED` : `all ${total} cases PASS`}`);
process.exit(failed ? 1 : 0);
