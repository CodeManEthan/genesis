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

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gdir = join(root, 'src/components/designs/genesis');

const { mulberry32, hashSeed } = await import(join(gdir, 'types.ts'));
const { buildTimeline, emptySnapshot, snapshotAt, advance } = await import(
  join(gdir, 'timeline.ts')
);

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
    const props = [
      { id: `s${s}-well`, kind: 'well', gx: cx - 2, gy: cy, seed: 1 },
      { id: `s${s}-board`, kind: 'nameboard', gx: cx - 3, gy: cy + 1, seed: 2 },
      { id: `s${s}-crates`, kind: 'crates', gx: cx + 1, gy: cy - 2, seed: 3 },
      { id: `s${s}-lamp0`, kind: 'lamp', gx: cx, gy: cy + 3, seed: 4 },
      { id: `s${s}-lamp1`, kind: 'lamp', gx: cx + 3, gy: cy + 3, seed: 5 },
      { id: `s${s}-sheep`, kind: 'sheep', gx: cx + 5, gy: cy + 5, seed: 6 },
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

function serialize(snap) {
  const m = (x) => [...x.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const s = (x) => [...x].sort();
  return JSON.stringify({
    t: snap.t,
    trees: m(snap.trees),
    buildings: m(snap.buildings),
    roads: m(snap.roads),
    bridges: m(snap.bridges),
    fords: s(snap.fords ?? []),
    props: s(snap.props),
    chests: m(snap.chests),
    founded: s(snap.founded),
    population: m(snap.population),
    log: snap.log,
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

  /* (k) day arc: first road mid-morning, ledger well spread, quiet close */
  const roadEvents = ev.filter((e) => e.type === 'road');
  const firstRoad = roadEvents.length ? roadEvents[0].t : null;
  if (full && firstRoad !== null && firstRoad < 6)
    bad(`(k) first road at ${hhmm(firstRoad)} — too early for a mid-morning push`);
  const logs = ev.filter((e) => e.type === 'log');
  if (full) {
    if (logs.length < 25 || logs.length > 45) bad(`(k) ${logs.length} log lines, want 25..45`);
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
  for (const m of fails) console.log(`  ! ${m}`);
  return { fails, ev, tl, map, lastBuild, pace };
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

console.log(`\n${failed ? `${failed}/${total} CASES FAILED` : `all ${total} cases PASS`}`);
process.exit(failed ? 1 : 0);
