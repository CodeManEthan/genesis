/**
 * Genesis — the day's ledger.
 *
 * Turns a GenesisMap into a Timeline: the ordered list of everything that
 * happens in the valley between midnight and midnight. Pure, deterministic,
 * DOM-free. All randomness comes from mulberry32 seeded off map.seed, so the
 * same map always produces byte-identical events.
 *
 * The shape of a day:
 *   00:00    one house, two settlers, a wild valley.
 *   morning  the founding site builds up; a road pushes out mid-morning.
 *            a river crossing stops the road dead until the bridge is piled,
 *            decked and railed.
 *   midday   the road arrives, the next site is founded, settlers come, plots
 *            are cleared, surveyed, raised. Expansion runs site by site.
 *   ~21:00   the last roof goes on, whatever the size of the map.
 *   evening  lamps, a few log lines, and the valley goes quiet.
 *
 * Pacing is solved, not hardcoded. The scheduler takes one tempo knob `p`
 * (idle gaps stretch freely, work durations only within reason) and
 * buildTimeline bisects on it until the last roof lands in the target window,
 * then applies a small uniform correction. A two-house world simply has a
 * leisurely day; a five-town world hustles.
 */

import type {
  BridgeSpec,
  BuildingSpec,
  GenesisEvent,
  GenesisMap,
  RoadSpec,
  SiteSpec,
  Timeline,
  Vec2,
  WorldSnapshot,
} from './types.ts';
import { mulberry32 } from './types.ts';
import { dayTypeOf, stormWarp, type DayType } from './daytype.ts';

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** one world-minute, expressed in hours */
const MIN = 1 / 60;

/** how many ledger lines the snapshot keeps */
const LOG_CAP = 60;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** cumulative arclength of a polyline, in tile units */
function polyMetrics(pts: Vec2[]): { cum: number[]; total: number } {
  const cum = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    cum.push(total);
  }
  return { cum, total };
}

/** arclength fraction of the point on `pts` closest to (gx, gy) */
function nearestFrac(pts: Vec2[], gx: number, gy: number): number {
  const { cum, total } = polyMetrics(pts);
  if (!(total > 0) || pts.length < 2) return 0;
  let best = Infinity;
  let frac = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0];
    const ay = pts[i - 1][1];
    const dx = pts[i][0] - ax;
    const dy = pts[i][1] - ay;
    const l2 = dx * dx + dy * dy;
    let u = l2 > 0 ? ((gx - ax) * dx + (gy - ay) * dy) / l2 : 0;
    u = clamp(u, 0, 1);
    const px = ax + dx * u;
    const py = ay + dy * u;
    const d = (px - gx) * (px - gx) + (py - gy) * (py - gy);
    if (d < best) {
      best = d;
      frac = (cum[i - 1] + u * Math.sqrt(l2)) / total;
    }
  }
  return clamp(frac, 0, 1);
}

/** a building worth writing a log line about when it tops out */
function isLandmark(b: BuildingSpec): boolean {
  return (
    b.floors >= 3 ||
    b.w >= 48 ||
    b.role === 'hall' ||
    b.role === 'chapel' ||
    b.role === 'tower' ||
    b.role === 'mill'
  );
}

/** minutes of work a building is worth — a big hall is ~2.5x a cottage */
function buildMinutes(b: BuildingSpec): number {
  return 26 + b.w * 0.9 + (b.floors - 1) * 22;
}

/* -------------------------------------------------------------------------- */
/* expansion skeleton — who founds whom, over which road                      */
/* -------------------------------------------------------------------------- */

interface Step {
  road: RoadSpec | null;
  siteId: string;
}

interface Skeleton {
  steps: Step[];
  /** roads that link two already-founded sites; laid later, found nothing */
  extras: RoadSpec[];
}

function expansionOrder(map: GenesisMap): Skeleton {
  const order = new Map<string, number>();
  map.sites.forEach((s, i) => order.set(s.id, i));

  const founded = new Set<string>();
  if (map.sites.length) founded.add(map.sites[0].id);

  const used = new Set<string>();
  const steps: Step[] = [];

  for (;;) {
    let pick: { rank: number; road: RoadSpec; siteId: string } | null = null;
    for (const r of map.roads) {
      if (used.has(r.id)) continue;
      if (!order.has(r.from) || !order.has(r.to) || r.from === r.to) continue;
      const fa = founded.has(r.from);
      const fb = founded.has(r.to);
      if (fa === fb) continue;
      const siteId = fa ? r.to : r.from;
      const rank = order.get(siteId)!;
      if (!pick || rank < pick.rank) pick = { rank, road: r, siteId };
    }
    if (!pick) break;
    used.add(pick.road.id);
    founded.add(pick.siteId);
    steps.push({ road: pick.road, siteId: pick.siteId });
  }

  // sites the road network never reaches still get founded, just on foot
  for (let i = 1; i < map.sites.length; i++) {
    const s = map.sites[i];
    if (!founded.has(s.id)) {
      founded.add(s.id);
      steps.push({ road: null, siteId: s.id });
    }
  }

  return { steps, extras: map.roads.filter((r) => !used.has(r.id)) };
}

/* -------------------------------------------------------------------------- */
/* the scheduler                                                              */
/* -------------------------------------------------------------------------- */

interface SiteRun {
  site: SiteSpec;
  foundT: number;
  /** settlers in the founding party (0 for sites[0], which starts with 2) */
  settlers: number;
  /** finish time of each building actually raised today, in build order */
  finishes: { b: BuildingSpec; t: number }[];
  doneT: number;
  /** when the site's first new roof is on — this releases the next road */
  firstT: number;
  population: number;
}

interface Plan {
  events: GenesisEvent[];
  runs: Map<string, SiteRun>;
  /** site ids in founding order */
  order: string[];
  bridgeDone: { t: number; bridgeId: string; siteId: string | null }[];
  /** roads that had to be cut through standing forest, worth a ledger line */
  roadCuts: { t: number; roadId: string; kind: string; siteId: string | null; n: number }[];
  lastBuildT: number;
}

/**
 * Lay out the whole day at tempo `p`. Higher p = more idle time between jobs
 * (and, up to a limit, slower work). The rng draw *sequence* is deliberately
 * independent of `p` so that lastBuildT is a smooth monotone function of it.
 */
function plan(map: GenesisMap, skel: Skeleton, p: number): Plan {
  const rng = mulberry32(((map.seed >>> 0) ^ 0x5eed1a7e) >>> 0);
  const range = (a: number, b: number) => a + rng() * (b - a);
  const int = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));

  /** work durations stretch/compress only within reason … */
  const dm = clamp(p, 0.3, 2.0);
  /** … idle gaps soak up whatever slack is left */
  const gm = clamp(p, 0.4, 40);
  /** the first road leaves mid-morning even on a crowded map — the founding
   * site has to look like a homestead before it looks like a trailhead */
  const morning = 7.2 + rng() * 1.9;

  const ev: GenesisEvent[] = [];
  const runs = new Map<string, SiteRun>();
  const order: string[] = [];
  const bridgeDone: Plan['bridgeDone'] = [];
  const roadCuts: Plan['roadCuts'] = [];
  const treeIds = new Set(map.trees.map((t) => t.id));
  /** claimed — nobody fells a tree twice */
  const felled = new Set<string>();
  /** when each felled tree actually came down */
  const felledAt = new Map<string, number>();
  /** Trees standing on a planned route. Road crews get first refusal on these:
   * a tree left standing on finished road surface looks broken, whereas one
   * left a moment too long on a surveyed plot merely looks like a Tuesday. */
  const roadClaimed = new Set<string>();
  for (const r of map.roads) for (const c of r.clears ?? []) roadClaimed.add(c.tree);
  let lastBuildT = 0;

  const bridgesByRoad = new Map<string, BridgeSpec[]>();
  for (const br of map.bridges) {
    const list = bridgesByRoad.get(br.roadId);
    if (list) list.push(br);
    else bridgesByRoad.set(br.roadId, [br]);
  }

  /* ---------------------------- one settlement --------------------------- */

  function scheduleSite(site: SiteSpec, startT: number, founding: boolean): SiteRun {
    // the founding house of sites[0] already stands at midnight
    const list = founding ? site.buildings.slice(1) : site.buildings;

    let pop = founding ? 2 : 0;
    let settlers = 0;
    const crew: number[] = [startT];
    // plots can carry a dozen trees now, so put more axes on the biggest one —
    // otherwise clearing swallows the whole day
    const biggest = list.reduce((n, b) => Math.max(n, b.clears.length), 0);
    const axes: number[] = new Array(clamp(2 + Math.floor(biggest / 4), 2, 4)).fill(startT);
    const finishes: { b: BuildingSpec; t: number }[] = [];

    if (!founding) {
      const n = int(2, 4);
      ev.push({ t: startT + range(1, 6) * MIN * gm, type: 'arrive', siteId: site.id, n });
      pop = n;
      settlers = n;
    }

    // later arrivals at a busy site, on a fixed cadence so the rng draw count
    // never depends on the tempo knob
    const nExtra = clamp(1 + Math.floor(list.length / 2), 1, 4);
    const arrivalAt = new Set<number>();
    for (let k = 0; k < nExtra; k++) {
      const i = (founding ? 0 : 1) + k * 2;
      if (i < list.length) arrivalAt.add(i);
    }

    for (let i = 0; i < list.length; i++) {
      const b = list[i];

      if (arrivalAt.has(i)) {
        const at = Math.min(...crew) + range(0, 5) * MIN * gm;
        const n = int(2, 4);
        ev.push({ t: at, type: 'arrive', siteId: site.id, n });
        pop += n;
      }
      // a second gang, once there are enough hands to spare one
      if (pop > 4 && crew.length < 2) crew.push(Math.min(...crew) + range(2, 12) * MIN * gm);

      let ci = 0;
      for (let k = 1; k < crew.length; k++) if (crew[k] < crew[ci]) ci = k;
      const t0 = crew[ci];

      // clear the plot — two to four axes swinging at once per site
      let cleared = t0;
      for (const treeId of b.clears) {
        if (!treeIds.has(treeId)) continue;
        const down = felledAt.get(treeId);
        if (down !== undefined) {
          // somebody already took it — the plot is not clear until they did
          if (down > cleared) cleared = down;
          continue;
        }
        if (felled.has(treeId)) continue;
        // a tree the road is going to have to take down anyway: leave it
        if (roadClaimed.has(treeId)) continue;
        felled.add(treeId);
        let k = 0;
        for (let j = 1; j < axes.length; j++) if (axes[j] < axes[k]) k = j;
        const cs = Math.max(axes[k], t0);
        const cd = cs + range(10, 25) * MIN * dm;
        axes[k] = cd;
        felledAt.set(treeId, cd);
        ev.push({ t: cs, type: 'chop-start', treeId });
        ev.push({ t: cd, type: 'chop-done', treeId });
        if (cd > cleared) cleared = cd;
      }

      const surveyT = cleared + range(4, 10) * MIN * gm;
      ev.push({ t: surveyT, type: 'survey', buildingId: b.id });

      const start = surveyT + range(3, 8) * MIN * gm;
      const dur = buildMinutes(b) * range(0.85, 1.15) * MIN * dm;

      const steps: number[] = [];
      let prog = 0.05;
      for (let guard = 0; guard < 64; guard++) {
        prog += range(0.04, 0.08);
        if (prog >= 1) break;
        steps.push(prog);
      }
      steps.push(1);

      const dt = dur / steps.length;
      let fin = start;
      for (let s = 0; s < steps.length; s++) {
        fin = start + dt * (s + 1);
        ev.push({ t: fin, type: 'build', buildingId: b.id, progress: steps[s] });
      }
      if (fin > lastBuildT) lastBuildT = fin;

      crew[ci] = fin + range(6, 22) * MIN * gm;
      finishes.push({ b, t: fin });
    }

    const run: SiteRun = {
      site,
      foundT: founding ? 0 : startT,
      settlers,
      finishes,
      doneT: finishes.length ? Math.max(...finishes.map((f) => f.t)) : startT,
      firstT: finishes.length ? finishes[0].t : startT,
      population: pop,
    };
    runs.set(site.id, run);
    order.push(site.id);
    return run;
  }

  /* -------------------------------- a road -------------------------------- */

  function scheduleRoad(
    road: RoadSpec,
    startT: number,
    siteId: string | null,
    budget?: number,
  ): number {
    const { total } = polyMetrics(road.pts);
    let dur = clamp(24 + total * 2.0, 30, 90) * MIN * dm;
    if (budget !== undefined) dur = Math.min(dur, Math.max(0.25, budget));

    // trees standing on the route, in the order the head will meet them
    const cut = (road.clears ?? [])
      .filter((c) => treeIds.has(c.tree) && !felled.has(c.tree))
      .map((c) => ({ tree: c.tree, frac: clamp(c.frac, 0, 1) }))
      .sort((a, b) => a.frac - b.frac);
    for (const c of cut) felled.add(c.tree);

    const brs = (bridgesByRoad.get(road.id) ?? [])
      .map((b) => ({ spec: b, gate: clamp(nearestFrac(road.pts, b.gx, b.gy), 0.06, 0.9) }))
      .sort((a, b) => a.gate - b.gate);

    type Item = { frac: number; br: BridgeSpec | null };
    const nsteps = int(9, 16);
    const raw: Item[] = [];
    for (let i = 1; i <= nsteps; i++) raw.push({ frac: i / nsteps, br: null });
    for (const b of brs) raw.push({ frac: b.gate, br: b.spec });
    raw.sort((a, b) => a.frac - b.frac || (a.br ? 1 : 0) - (b.br ? 1 : 0));

    // merge near-coincident stops; a bridge always wins its slot
    const items: Item[] = [];
    for (const it of raw) {
      const prev = items[items.length - 1];
      if (prev && it.frac - prev.frac < 1.5e-3) {
        if (it.br && !prev.br) {
          prev.br = it.br;
          prev.frac = it.frac;
        } else if (it.br) {
          items.push({ frac: prev.frac + 1.5e-3, br: it.br });
        }
        continue;
      }
      items.push({ frac: it.frac, br: it.br });
    }
    const last = items[items.length - 1];
    if (!last) items.push({ frac: 1, br: null });
    else if (last.frac < 1) items.push({ frac: 1, br: null });
    else last.frac = 1;

    // Walk the construction head. Each stop records when the head arrived, so
    // that the felling pass below can work backwards from it. Dense stretches
    // cost extra: cutting a line through wood is slower than laying stone.
    const bounds: { f: number; t: number }[] = [{ f: 0, t: startT }];
    let t = startT;
    let prevF = 0;
    let ci = 0;
    let endT = startT;
    for (const it of items) {
      let slog = 0;
      while (ci < cut.length && cut[ci].frac <= it.frac) {
        slog += range(4, 10) * MIN * dm;
        ci++;
      }
      t += (it.frac - prevF) * dur + slog;
      ev.push({ t, type: 'road', roadId: road.id, frac: it.frac });
      bounds.push({ f: it.frac, t });
      prevF = it.frac;
      endT = t;
      if (it.br) {
        // the road stops dead at the water until the crossing is finished
        const pause = range(32, 48) * MIN * dm;
        ev.push({ t: t + pause * 0.24, type: 'bridge', bridgeId: it.br.id, stage: 1 });
        ev.push({ t: t + pause * 0.62, type: 'bridge', bridgeId: it.br.id, stage: 2 });
        ev.push({ t: t + pause, type: 'bridge', bridgeId: it.br.id, stage: 3 });
        bridgeDone.push({ t: t + pause, bridgeId: it.br.id, siteId });
        endT = t + pause;
        t = endT + range(2, 9) * MIN * gm;
      }
    }

    /* the axe gang, working just ahead of the head ------------------------- */
    if (cut.length) {
      /** when the head reaches `f` — never later than the road event that
       * carries the road past it, which is what makes the invariant hold */
      const headAt = (f: number): number => {
        if (f <= bounds[0].f) return bounds[0].t;
        for (let i = 1; i < bounds.length; i++) {
          if (f <= bounds[i].f) {
            const a = bounds[i - 1];
            const b = bounds[i];
            const span = b.f - a.f;
            return span > 0 ? a.t + ((f - a.f) / span) * (b.t - a.t) : b.t;
          }
        }
        return bounds[bounds.length - 1].t;
      };

      // three axes in flight per road crew
      const gang = [-Infinity, -Infinity, -Infinity];
      let firstCut = Infinity;
      for (const c of cut) {
        const lead = range(0.03, 0.05);
        const d = range(10, 25) * MIN * dm;
        // it MUST be down before the head gets there
        const deadline = headAt(c.frac) - 0.5 * MIN;
        let k = 0;
        for (let j = 1; j < gang.length; j++) if (gang[j] < gang[k]) k = j;
        let cs = Math.max(0.02, gang[k], Math.min(headAt(Math.max(0, c.frac - lead)), deadline - d));
        let cd = Math.min(cs + d, deadline);
        if (!(cd > cs)) {
          // crews saturated right up against the deadline: they hurry
          cd = deadline;
          cs = Math.max(0.01, deadline - 0.4 * MIN);
        }
        gang[k] = cd;
        felledAt.set(c.tree, cd);
        ev.push({ t: cs, type: 'chop-start', treeId: c.tree });
        ev.push({ t: cd, type: 'chop-done', treeId: c.tree });
        if (cs < firstCut) firstCut = cs;
      }
      if (cut.length >= 4) {
        roadCuts.push({ t: firstCut, roadId: road.id, kind: road.kind, siteId, n: cut.length });
      }
    }

    return endT;
  }

  /* ------------------------------ the day itself -------------------------- */

  if (!map.sites.length) return { events: ev, runs, order, bridgeDone, roadCuts, lastBuildT };

  const r0 = scheduleSite(map.sites[0], 0.05, true);

  let prevRoadEnd = r0.firstT;
  let prevRun = r0;
  const laid = new Set<string>();

  for (let i = 0; i < skel.steps.length; i++) {
    const step = skel.steps[i];
    const site = map.sites.find((s) => s.id === step.siteId);
    if (!site) continue;

    let start: number;
    if (i === 0) {
      // the first road leaves once the founding site has a second roof on it
      const anchor = r0.finishes.length ? r0.finishes[Math.min(1, r0.finishes.length - 1)].t : 0.6;
      start = Math.max(anchor + range(12, 34) * MIN * gm, morning);
    } else {
      start = Math.max(
        prevRoadEnd + range(18, 45) * MIN * gm,
        prevRun.firstT + range(5, 30) * MIN * gm,
      );
    }

    let roadEnd: number;
    if (step.road) {
      roadEnd = scheduleRoad(step.road, start, site.id);
      laid.add(step.road.id);
    } else {
      roadEnd = start + range(40, 90) * MIN * gm;
    }

    const foundT = roadEnd + range(4, 14) * MIN * gm;
    ev.push({ t: foundT, type: 'found', siteId: site.id, text: `${site.name} is founded.` });

    const run = scheduleSite(site, foundT + range(3, 12) * MIN * gm, false);
    run.foundT = foundT;
    prevRoadEnd = roadEnd;
    prevRun = run;
  }

  // link roads that found nothing get laid once both their ends exist
  for (const road of skel.extras) {
    if (laid.has(road.id)) continue;
    const a = runs.get(road.from);
    const b = runs.get(road.to);
    const after = Math.max(a ? a.foundT : 0, b ? b.foundT : 0, 0.4);
    const want = after + range(30, 110) * MIN * gm;
    const start = Math.max(after + 8 * MIN, Math.min(want, 21.4));
    scheduleRoad(road, start, b ? b.site.id : null, Math.max(0.3, 22.6 - start));
    laid.add(road.id);
  }

  // any bridge whose road isn't in the map still has to get built
  const seen = new Set(bridgeDone.map((b) => b.bridgeId));
  for (const br of map.bridges) {
    if (seen.has(br.id)) continue;
    const t = 12 + range(0, 6);
    ev.push({ t, type: 'bridge', bridgeId: br.id, stage: 1 });
    ev.push({ t: t + 12 * MIN, type: 'bridge', bridgeId: br.id, stage: 2 });
    ev.push({ t: t + 26 * MIN, type: 'bridge', bridgeId: br.id, stage: 3 });
    bridgeDone.push({ t: t + 26 * MIN, bridgeId: br.id, siteId: null });
  }

  return { events: ev, runs, order, bridgeDone, roadCuts, lastBuildT };
}

/** uniform time correction — preserves ordering and every monotonic chain */
function scalePlan(pl: Plan, s: number): void {
  if (!(s > 0) || !isFinite(s) || Math.abs(s - 1) < 1e-9) return;
  for (const e of pl.events) e.t *= s;
  for (const run of pl.runs.values()) {
    run.foundT *= s;
    run.doneT *= s;
    run.firstT *= s;
    for (const f of run.finishes) f.t *= s;
  }
  for (const b of pl.bridgeDone) b.t *= s;
  for (const c of pl.roadCuts) c.t *= s;
  pl.lastBuildT *= s;
}

/* -------------------------------------------------------------------------- */
/* narration — dressing, and the ledger the valley keeps about itself         */
/* -------------------------------------------------------------------------- */

const FOUND_TEXT = [
  '{town} is founded.',
  '{town} takes its name.',
  '{town} is founded, and staked out before dark.',
  '{town} is on the map.',
];

const FOUND_LOG = [
  'The road runs out at a good spot. They call it {town}, and it belongs to {valley} now.',
  '{n} settlers walk into the far meadow and stop walking. {town}, in {valley}.',
  '{town} founded: four stakes, a length of string, and an argument about the well.',
  'Another smoke in {valley}. {town} has a name before it has a roof.',
  'They reach the end of the road and decide it is far enough. {town} is founded in {valley}.',
  '{town} is founded. {n} settlers, two carts, and no idea what the winters are like here.',
];

const FIRST_TREE = [
  'First tree down in {valley}. It takes three of them and most of the morning.',
  'The first oak comes over, and the sound of it carries the length of {valley}.',
  'First axe into first trunk. Everything after this is carpentry.',
];

const BRIDGE_LOG = [
  'The crossing is decked and railed. Carts go over dry.',
  'Bridge finished. Somebody jumps on it, twice, to be sure.',
  'Pilings, deck, rails — and the river stops being an argument.',
  'The bridge holds. The road remembers where it was going.',
];

const ROAD_CUT_LOG = [
  'Axes go out ahead of the {kind}: they are cutting a line through the wood toward {town}.',
  'The {kind} to {town} runs into the trees. Progress is measured in stumps.',
  '{n} trees have to come down before the {kind} can get any nearer {town}.',
  'The wood between here and {town} does not want a {kind} through it. It is getting one.',
];

const LANDMARK_LOG = [
  '{label} tops out at {town}. Tallest thing for a mile.',
  'They put the roof on {label} at {town} and stand back to look at it.',
  '{label} is finished at {town}. It will be the thing people mean by {town}.',
  'Last rafter into {label} at {town}, and a hat thrown at it.',
];

const SITE_DONE_LOG = [
  '{town} is finished: {nb} buildings, {pop} settlers, one well.',
  'Last shingle at {town}. Nobody has anything left to build.',
  '{town} stops being a building site and starts being a town.',
  'The tools are stacked at {town}. That is all of it.',
];

const POOL_NIGHT_EARLY = [
  'Owls over {valley}. Nothing else moves.',
  'Frost on the stacked timber. Nobody touches it until light.',
  'One lamp in one window at {town}, and the rest of {valley} dark.',
  'The river talks to itself all night.',
];

const POOL_DAWN = [
  // (The mist line that used to sit here now belongs to WEATHER_LOG below: it
  // is only drawn on a day that actually has mist in it, and on those days it
  // is a report rather than a turn of phrase.)
  'Dew off the grass by seven, and the shadows still long at {town}.',
  'First smoke of the day from {town}.',
  'They eat standing up at {town} and start early.',
  'The sun comes over the ridge and {valley} goes the colour of hay.',
];

const POOL_MORNING = [
  'The saw pit at {town} runs all morning.',
  "Somebody's dog adopts the survey crew and will not be dissuaded.",
  'A cart tries the new road, gets through, and comes back with news.',
  'Nails counted twice at {town}. The two counts disagree.',
  'Bees found in a hollow oak. The oak is spared.',
  'A heron on the river watches the pilings go in, unimpressed.',
  'Sawyers follow the road crew, squaring up what the axes put down.',
];

const POOL_MIDDAY = [
  'Cloud shadow drags across the fields all afternoon.',
  'Sheep on the {town} road. Ownership disputed at length.',
  'A ridge beam goes up at {town} to a certain amount of shouting.',
  'Rooks move into the tallest tree the axes missed.',
  'Rain crosses {valley} sideways and is gone in ten minutes.',
  'Two riders pass through {town} without stopping. This is noted.',
  'The smell of cut pine carries all the way back to {town}.',
];

const POOL_EVENING = [
  'The well at {town} comes in sweet. Relief all round.',
  'Lamps lit along the {town} lane, one at a time, by one man with a taper.',
  'A pedlar sets up at the {town} crossroads and sells absolutely nothing.',
  'Long light down {valley}. Every roof gets an hour of gold.',
  'The road to {town} is walked flat by evening.',
];

const POOL_NIGHT = [
  'Supper eaten outdoors. Nobody wants to go in.',
  'Somebody is singing at {town}. Badly, and at length.',
  'Lamplight on fresh shavings all down the {town} lane.',
  'A late cart comes in and is unloaded by feel.',
];

/** only ever drawn after the last roof is on */
const POOL_CLOSING = [
  'The last hammer stops and {valley} goes quiet.',
  'Stars over {valley}. The day’s work stands where it was left.',
  'Doors shut along the lane. Tomorrow the world starts again from nothing.',
  'The tools are under canvas. {valley} sleeps with the shape it finished in.',
  'One lamp still burning at {town}. Then not.',
];

function poolFor(t: number): string[] {
  if (t < 5) return POOL_NIGHT_EARLY;
  if (t < 8) return POOL_DAWN;
  if (t < 12) return POOL_MORNING;
  if (t < 16.5) return POOL_MIDDAY;
  if (t < 20) return POOL_EVENING;
  return POOL_NIGHT;
}

function fill(tpl: string, v: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
}

/** deterministic draw-without-replacement across a template pool */
function makeDrawer(rng: () => number) {
  const bags = new Map<string[], number[]>();
  return (pool: string[]): string => {
    let bag = bags.get(pool);
    if (!bag || !bag.length) {
      bag = pool.map((_, i) => i);
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = bag[i];
        bag[i] = bag[j];
        bag[j] = tmp;
      }
      bags.set(pool, bag);
    }
    return pool[bag.pop()!];
  };
}

/** ties at the same `t` resolve so a log always follows the thing it reports */
const TYPE_RANK: Record<GenesisEvent['type'], number> = {
  found: 0,
  arrive: 1,
  'chop-start': 2,
  'chop-done': 3,
  survey: 4,
  build: 5,
  road: 6,
  bridge: 7,
  prop: 8,
  log: 9,
};

function narrate(map: GenesisMap, pl: Plan): GenesisEvent[] {
  const rng = mulberry32(((map.seed >>> 0) ^ 0x10cedade) >>> 0);
  const range = (a: number, b: number) => a + rng() * (b - a);
  const draw = makeDrawer(rng);
  const valley = map.valleyName;
  const out = pl.events;

  /* --- founding blurbs, written onto the events the scheduler already made */
  for (const e of out) {
    if (e.type !== 'found') continue;
    const run = pl.runs.get(e.siteId);
    e.text = fill(draw(FOUND_TEXT), { town: run ? run.site.name : e.siteId });
  }

  /* --- milestone ledger lines ------------------------------------------- */
  type Line = { t: number; text: string; siteId?: string };
  const key: Line[] = [];
  const landmarks: Line[] = [];

  for (const sid of pl.order) {
    const run = pl.runs.get(sid)!;
    if (run.foundT > 0) {
      key.push({
        t: run.foundT,
        siteId: sid,
        text: fill(draw(FOUND_LOG), { town: run.site.name, valley, n: run.settlers || 3 }),
      });
    }
  }

  let firstChop: number | null = null;
  for (const e of out) {
    if (e.type === 'chop-start' && (firstChop === null || e.t < firstChop)) firstChop = e.t;
  }
  if (firstChop !== null) {
    key.push({ t: firstChop + 0.02, text: fill(draw(FIRST_TREE), { valley }) });
  }

  for (const b of pl.bridgeDone) {
    const run = b.siteId ? pl.runs.get(b.siteId) : undefined;
    const line: Line = {
      t: b.t,
      text: fill(draw(BRIDGE_LOG), { valley, town: run ? run.site.name : valley }),
    };
    if (b.siteId) line.siteId = b.siteId;
    key.push(line);
  }

  for (const c of pl.roadCuts) {
    const run = c.siteId ? pl.runs.get(c.siteId) : undefined;
    const line: Line = {
      t: c.t,
      text: fill(draw(ROAD_CUT_LOG), {
        kind: c.kind,
        n: c.n,
        town: run ? run.site.name : valley,
        valley,
      }),
    };
    if (c.siteId) line.siteId = c.siteId;
    key.push(line);
  }

  for (const sid of pl.order) {
    const run = pl.runs.get(sid)!;
    for (const f of run.finishes) {
      if (!isLandmark(f.b)) continue;
      landmarks.push({
        t: f.t,
        siteId: sid,
        text: fill(draw(LANDMARK_LOG), { label: f.b.label, town: run.site.name }),
      });
    }
  }

  for (const sid of pl.order) {
    const run = pl.runs.get(sid)!;
    if (!run.finishes.length) continue;
    key.push({
      t: run.doneT,
      siteId: sid,
      text: fill(draw(SITE_DONE_LOG), {
        town: run.site.name,
        nb: run.site.buildings.length,
        pop: run.population,
      }),
    });
  }

  // keep the ledger readable on very large maps: thin landmark lines first
  let keptLandmarks = landmarks;
  const room = 33 - key.length;
  if (landmarks.length > Math.max(2, room)) {
    const stride = Math.ceil(landmarks.length / Math.max(2, room));
    keptLandmarks = landmarks.filter((_, i) => i % stride === 0);
  }
  const lines: Line[] = key.concat(keptLandmarks);

  /* --- pure flavour, spread across the whole day -------------------------- */
  const foundOrder = pl.order.map((sid) => pl.runs.get(sid)!);
  const want = 28 + Math.floor(rng() * 11); // 28..38 lines all told
  const need = clamp(want - lines.length, 4, 30);
  for (let i = 0; i < need; i++) {
    const t = clamp(0.55 + ((i + 0.5) / need) * 22.5 + range(-0.35, 0.35), 0.3, 23.4);
    const open = foundOrder.filter((r) => r.foundT <= t);
    const pickFrom = open.length ? open : foundOrder;
    const who = pickFrom[Math.floor(rng() * pickFrom.length)];
    lines.push({
      t,
      text: fill(draw(poolFor(t)), { valley, town: who ? who.site.name : valley }),
    });
  }

  // and the valley signing off, after the last hammer
  const lastRoof = Math.max(0, ...out.filter((e) => e.type === 'build').map((e) => e.t));
  const closers = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < closers; i++) {
    const t = clamp(
      Math.max(lastRoof + 0.15, 22.2) + (i / closers) * 1.3 + range(0, 0.22),
      22.1,
      23.9,
    );
    const who = foundOrder[Math.floor(rng() * Math.max(1, foundOrder.length))];
    lines.push({
      t,
      text: fill(draw(POOL_CLOSING), { valley, town: who ? who.site.name : valley }),
    });
  }

  /* --- site dressing ------------------------------------------------------ */
  for (const sid of pl.order) {
    const run = pl.runs.get(sid)!;
    const props = run.site.props;
    if (!props.length) continue;

    const lo = Math.max(0.1, run.foundT + 0.15);
    const hi = clamp(Math.max(run.doneT, lo + 1.2), lo + 0.5, 23.0);
    const second = run.finishes.length >= 2 ? run.finishes[1].t : run.doneT;

    const times: number[] = [];
    for (let i = 0; i < props.length; i++) {
      const kind = props[i].kind;
      let t: number;
      if (i === 0 || kind === 'well' || kind === 'stake' || kind === 'campfire') {
        t = run.foundT + range(0.2, 0.9); // a well before anything else
      } else if (kind === 'nameboard' || kind === 'signpost') {
        t = second + range(0.05, 0.35); // once there are two roofs to name
      } else if (kind === 'lamp') {
        t = range(17.9, 19.2); // lit at dusk
      } else {
        t = lo + ((i + 1) / (props.length + 1)) * (hi - lo) + range(-0.2, 0.2);
      }
      times.push(clamp(t, lo, 23.3));
    }
    // props appear in array order, so sort the times and pair them up in order
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      if (times[i] <= times[i - 1]) times[i] = times[i - 1] + 0.5 * MIN;
    }
    for (let i = 0; i < props.length; i++) {
      out.push({ t: times[i], type: 'prop', propId: props[i].id, siteId: run.site.id });
    }
  }

  /* --- fold in and sort --------------------------------------------------- */
  for (const l of lines) {
    out.push(
      l.siteId
        ? { t: l.t, type: 'log', text: l.text, siteId: l.siteId }
        : { t: l.t, type: 'log', text: l.text },
    );
  }
  for (const e of out) e.t = clamp(e.t, 0.01, 23.97);
  out.sort((a, b) => a.t - b.t || TYPE_RANK[a.type] - TYPE_RANK[b.type]);
  return out;
}

/* -------------------------------------------------------------------------- */
/* rare days                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the ledger says about a day that is not an ordinary day. One line per
 * phenomenon, two where the thing has an end worth reporting, and written the
 * same way as everything else: dry, and about people rather than weather.
 */
const WEATHER_LOG: Record<Exclude<DayType, 'normal'>, string[]> = {
  mist: ['Mist sits low in {valley} until the sun gets under it.'],
  eclipse: [
    'Something gets in front of the sun. Lamps lit at two in the afternoon, and the birds fooled.',
    'The light comes back over {valley}. Nobody says much about it, and the work goes on.',
  ],
  storm: [
    'Rain comes over the ridge and {valley} puts its tools down.',
    'The rain moves off. Wet timber, and an afternoon to make up before dark.',
  ],
  aurora: ['Green light standing over the north ridge. Nobody at {town} goes in.'],
};

/**
 * The weather, applied to a finished timeline.
 *
 * Two things happen here and nowhere else. A storm *stops the valley*: every
 * event inside the rain is pushed through `stormWarp`, which is a monotone map
 * that is the identity outside the afternoon, so the last roof stays exactly
 * where the pacing solver put it and only the middle of the day is rearranged
 * into a quiet stretch and a hurried one. And every rare day gets its line or
 * two in the ledger, placed at the hour the thing is actually visible.
 *
 * Deliberately *after* the pace scaling: the weather is a fact about the
 * afternoon, not about how hard anybody is working.
 */
function weather(map: GenesisMap, events: GenesisEvent[]): GenesisEvent[] {
  const day = dayTypeOf(map.seed);
  if (day.type === 'normal') return events;

  const out =
    day.type === 'storm'
      ? events.map((e) => {
          const c = { ...e } as GenesisEvent;
          c.t = stormWarp(day, e.t);
          return c;
        })
      : events.slice();

  // When each line lands: the mist once the light is up and it is a fact rather
  // than a forecast, the aurora once it is properly out, and the two-line
  // phenomena on their own edges.
  const at =
    day.type === 'mist'
      ? [day.from + 1.6]
      : day.type === 'aurora'
        ? [day.from + 0.5]
        : [day.from + 0.22, day.to + 0.18];
  const rng = mulberry32(((map.seed >>> 0) ^ 0x5c0d1e77) >>> 0);
  const valley = map.valleyName;
  const town = map.sites.length ? map.sites[Math.floor(rng() * map.sites.length)].name : valley;
  WEATHER_LOG[day.type].forEach((tpl, i) => {
    if (i >= at.length) return;
    out.push({ t: clamp(at[i], 0.01, 23.97), type: 'log', text: fill(tpl, { valley, town }) });
  });

  for (const e of out) e.t = clamp(e.t, 0.01, 23.97);
  out.sort((a, b) => a.t - b.t || TYPE_RANK[a.type] - TYPE_RANK[b.type]);
  return out;
}

/* -------------------------------------------------------------------------- */
/* public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @param pace How hard the settlers work, relative to a normal day. 1 fills
 *   the day exactly (last roof ~21:00). 2 gets it all done by lunchtime.
 *   0.5 means the sun goes down on part-built roads and half-raised walls —
 *   the day is simply truncated at midnight, which is the intended result,
 *   not a failure. Clamped to [0.25, 4]; at exactly 1 the output is identical
 *   to the single-argument call.
 */
export function buildTimeline(map: GenesisMap, pace = 1): Timeline {
  const skel = expansionOrder(map);
  const target = 20.4 + mulberry32(((map.seed >>> 0) ^ 0x7a11c0de) >>> 0)() * 1.6;

  // solve for the tempo that puts the last roof on inside the target window
  let lo = 0.12;
  let hi = 48;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (plan(map, skel, mid).lastBuildT < target) lo = mid;
    else hi = mid;
  }

  const pl = plan(map, skel, (lo + hi) / 2);
  if (pl.lastBuildT > 0.25) scalePlan(pl, target / pl.lastBuildT);
  const events = narrate(map, pl);

  const k = Number.isFinite(pace) ? clamp(pace, 0.25, 4) : 1;
  if (k === 1) return { events: weather(map, events) };

  // work rate k => everything happens 1/k as far into the day. Events pushed
  // past midnight simply never happen; the array is sorted, so the tail just
  // falls off. Nothing downstream assumes a road reaches 1 or a building
  // reaches 'done'.
  const scaled: GenesisEvent[] = [];
  for (const e of events) {
    const t = e.t / k;
    if (t >= 24) break;
    const c = { ...e } as GenesisEvent;
    c.t = t;
    scaled.push(c);
  }
  return { events: weather(map, scaled) };
}

/** WorldSnapshot is structural; we hang a private cursor off it so that
 * `advance` stays O(events in range) instead of rescanning the timeline. */
interface Snap extends WorldSnapshot {
  _i: number;
}

export function emptySnapshot(map: GenesisMap): WorldSnapshot {
  // every building is listed from the start so the renderer never has to
  // distinguish "not in the map" from "not built yet"
  const buildings: WorldSnapshot['buildings'] = new Map();
  for (const s of map.sites) {
    for (const spec of s.buildings) buildings.set(spec.id, { status: 'unplanned', progress: 0 });
  }

  const roads = new Map<string, number>();
  for (const r of map.roads) roads.set(r.id, 0);

  const bridges = new Map<string, 0 | 1 | 2 | 3>();
  for (const br of map.bridges) bridges.set(br.id, 0);

  const founded = new Set<string>();
  const population = new Map<string, number>();
  const log: { t: number; text: string }[] = [];

  const s0 = map.sites[0];
  if (s0) {
    founded.add(s0.id);
    population.set(s0.id, 2);
    if (s0.buildings.length) buildings.set(s0.buildings[0].id, { status: 'done', progress: 1 });
    log.push({
      t: 0,
      text: `Two settlers raise the first house in ${map.valleyName}. They call the place ${s0.name}.`,
    });
  }

  const snap: Snap = {
    t: 0,
    trees: new Map(),
    buildings,
    roads,
    bridges,
    props: new Set(),
    founded,
    population,
    log,
    _i: 0,
  };
  return snap;
}

function applyEvent(s: Snap, e: GenesisEvent): void {
  switch (e.type) {
    case 'found':
      s.founded.add(e.siteId);
      s.log.push({ t: e.t, text: e.text });
      break;
    case 'arrive':
      s.population.set(e.siteId, (s.population.get(e.siteId) ?? 0) + e.n);
      break;
    case 'chop-start':
      s.trees.set(e.treeId, 'felling');
      break;
    case 'chop-done':
      s.trees.set(e.treeId, 'stump');
      break;
    case 'survey':
      s.buildings.set(e.buildingId, { status: 'surveyed', progress: 0.05 });
      break;
    case 'build':
      s.buildings.set(e.buildingId, {
        status: e.progress >= 1 ? 'done' : 'building',
        progress: e.progress,
      });
      break;
    case 'road':
      s.roads.set(e.roadId, e.frac);
      break;
    case 'bridge':
      s.bridges.set(e.bridgeId, e.stage);
      break;
    case 'prop':
      s.props.add(e.propId);
      break;
    case 'log':
      s.log.push({ t: e.t, text: e.text });
      break;
  }
  if (s.log.length > LOG_CAP) s.log.splice(0, s.log.length - LOG_CAP);
}

/** Forward-only. To scrub backwards, call snapshotAt. */
export function advance(snap: WorldSnapshot, tl: Timeline, toT: number): void {
  const s = snap as Snap;
  if (typeof s._i !== 'number') s._i = 0;
  if (toT < s.t) return;
  const evs = tl.events;
  while (s._i < evs.length && evs[s._i].t <= toT) {
    applyEvent(s, evs[s._i]);
    s._i++;
  }
  s.t = toT;
}

export function snapshotAt(map: GenesisMap, tl: Timeline, t: number): WorldSnapshot {
  const s = emptySnapshot(map);
  advance(s, tl, t);
  return s;
}
