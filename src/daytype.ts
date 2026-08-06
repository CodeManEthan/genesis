/**
 * Genesis — rare days, and the turning of the year.
 *
 * Two small pure questions about a seed, kept away from everything that
 * answers them:
 *
 *   what *kind* of day is this?   Most are ordinary. About one in four draws
 *                                 something: mist that burns off by nine, an
 *                                 eclipse at two in the afternoon, a storm that
 *                                 stops the crews for a couple of hours, an
 *                                 aurora after half past nine — or, rarest of
 *                                 the lot, a market, which is the one that is
 *                                 not weather at all.
 *   what *season* is it?          Which is a different question entirely — a
 *                                 date-derived world takes the real month, and
 *                                 a browsed seed derives one of its own.
 *
 * Both answers come off *derived* streams — `mulberry32(seed ^ salt)` — and
 * never off the generator's or the timeline's own RNG, so adding a day type
 * cannot move a single tree. `gen.ts` does not import this module and never
 * should: the terrain bytes of a seed are the same in January as in July.
 *
 * DOM-free and dependency-light, because `timeline.ts` (which runs under bare
 * node in the harnesses) needs the day type to know when it is raining.
 */

import { mulberry32, type GenesisMap, type SiteSpec, type Vec2 } from './types.ts';

export type DayType = 'normal' | 'mist' | 'eclipse' | 'storm' | 'aurora' | 'market';
export type Season = 'winter' | 'spring' | 'summer' | 'autumn';

export interface DayInfo {
  type: DayType;
  season: Season;
  /** The phenomenon's window, in hours. `0..0` on an ordinary day. */
  from: number;
  to: number;
}

/**
 * Frequencies. They sum to 0.20 — one day in five is *something* — and the
 * rarest is still better than one in forty, which is often enough that a week
 * of browsing finds it.
 */
const TABLE: [DayType, number][] = [
  ['mist', 0.06],
  ['storm', 0.06],
  ['aurora', 0.05],
  ['eclipse', 0.03],
  // MARKET — appended, never inserted. The table is walked cumulatively, so a
  // type on the end can only ever claim seeds that used to roll `normal`:
  // every mist day, storm day, aurora day and eclipse day in the archive is
  // still exactly the day it was.
  ['market', 0.035],
];

/** Salts. Distinct from every other salt in the codebase, deliberately. */
const SALT_TYPE = 0xda7c0de1;
const SALT_SEASON = 0x5ea50fa1;

/** The last hour a storm's catch-up may run to: safely before the last roof. */
const STORM_CATCHUP_TO = 19;
/** Fraction of a normal hour's work that gets done in the rain. */
const STORM_RATE = 0.12;

const SEASONS: Season[] = ['winter', 'spring', 'summer', 'autumn'];
/** Jan..Dec. December through February is winter, and so on. */
const BY_MONTH: Season[] = [
  'winter', 'winter', 'spring', 'spring', 'spring', 'summer',
  'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter',
];

/**
 * The day type of a seed, and when it happens.
 *
 * The window is drawn from the same stream whatever the type, so the draw count
 * never varies — which keeps the stream re-orderable if a fifth type is ever
 * slotted in above the others.
 */
export function dayTypeOf(seed: number): { type: DayType; from: number; to: number } {
  const r = mulberry32(((seed >>> 0) ^ SALT_TYPE) >>> 0);
  const roll = r();
  const a = r();
  const b = r();

  let acc = 0;
  let type: DayType = 'normal';
  for (const [k, p] of TABLE) {
    acc += p;
    if (roll < acc) {
      type = k;
      break;
    }
  }

  switch (type) {
    // Thick before first light, thinning from breakfast, gone by half nine.
    case 'mist':
      return { type, from: 4.9, to: 9.0 + a * 0.55 };
    // Early afternoon, and over inside three quarters of an hour.
    case 'eclipse': {
      const from = 13.45 + a * 0.22;
      return { type, from, to: from + 0.6 + b * 0.12 };
    }
    // Mid-afternoon, so the catch-up still has daylight to happen in.
    case 'storm': {
      const from = 13.6 + a * 1.9;
      return { type, from, to: from + 1.5 + b * 0.5 };
    }
    // From half past nine to midnight.
    case 'aurora':
      return { type, from: 21.4 + a * 0.35, to: 24 };
    // MARKET — carts are on the road at first light, the stalls are up by nine,
    // and they come down when the light goes rather than when the trade does.
    case 'market':
      return { type, from: 8.7 + a * 0.5, to: 19.3 + b * 0.7 };
    default:
      return { type: 'normal', from: 0, to: 0 };
  }
}

/**
 * @param month 1..12 when the seed came from a real date, `null` when it is an
 *   arbitrary browsed seed — which then derives a season of its own, so ‹ and ›
 *   walk through the year as well as through the valleys.
 */
export function seasonOf(seed: number, month: number | null = null): Season {
  if (month !== null && Number.isFinite(month)) {
    return BY_MONTH[((Math.round(month) - 1) % 12 + 12) % 12];
  }
  return SEASONS[Math.floor(mulberry32(((seed >>> 0) ^ SALT_SEASON) >>> 0)() * 4) % 4];
}

export function dayInfo(seed: number, month: number | null = null): DayInfo {
  const d = dayTypeOf(seed);
  return { ...d, season: seasonOf(seed, month) };
}

/** An ordinary summer day: the default wherever a caller has no opinion. */
export const PLAIN_DAY: DayInfo = { type: 'normal', season: 'summer', from: 0, to: 0 };

/* ------------------------------- intensities ------------------------------ */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};

/** Mist: full at first light, thinning steadily once the sun is up. */
export function mistAt(day: DayInfo, t: number): number {
  if (day.type !== 'mist' || t < day.from - 0.6 || t > day.to) return 0;
  const risen = smooth((t - (day.from - 0.6)) / 0.7);
  const hold = day.from + 2.6;
  const thin = t <= hold ? 1 : 1 - smooth((t - hold) / Math.max(0.4, day.to - hold));
  return risen * thin;
}

/** Eclipse: a single smooth bite out of the afternoon, with a short totality. */
export function eclipseAt(day: DayInfo, t: number): number {
  if (day.type !== 'eclipse' || t <= day.from || t >= day.to) return 0;
  const x = (t - day.from) / (day.to - day.from);
  return Math.pow(Math.sin(Math.PI * x), 0.75);
}

/** Storm: on in twelve minutes, off in twenty. */
export function stormAt(day: DayInfo, t: number): number {
  if (day.type !== 'storm' || t <= day.from - 0.2 || t >= day.to + 0.35) return 0;
  return smooth((t - (day.from - 0.2)) / 0.32) * (1 - smooth((t - day.to) / 0.35));
}

/** Aurora: comes up slowly once it is properly dark, and stays until midnight. */
export function auroraAt(day: DayInfo, t: number): number {
  if (day.type !== 'aurora' || t < day.from) return 0;
  return smooth((t - day.from) / 0.7);
}

/* --------------------------------- storms -------------------------------- */

/**
 * Where the storm puts an event that was scheduled for `t`.
 *
 * Rain stops work; the crews make it up afterwards. This is a monotone time
 * warp on the finished timeline rather than anything inside the scheduler:
 * outside `[from, STORM_CATCHUP_TO]` it is the identity, so the last roof of
 * the day lands exactly where the pacing solver put it, and inside it the
 * valley does a couple of hours of very little followed by a couple of hours of
 * hurry.
 *
 * It runs on the *scaled* timeline, because a storm is a fact about the
 * afternoon and not about how hard the settlers are working: at pace 4 the
 * valley is finished long before the first drop and the warp finds nothing.
 */
export function stormWarp(day: DayInfo, t: number): number {
  if (day.type !== 'storm') return t;
  const s = day.from;
  const e = day.to;
  const r = STORM_CATCHUP_TO;
  if (t <= s || t >= r || e >= r) return t;
  // Work delivered while it rains, in hours of ordinary progress.
  const wet = STORM_RATE * (e - s);
  if (t <= s + wet) return s + (t - s) / STORM_RATE;
  // ...and the rate the rest of the window has to run at to end level again.
  const catchUp = (r - s - wet) / (r - e);
  return e + (t - s - wet) / catchUp;
}

/** How fast the crews move at `t` — they shelter, mostly, while it rains. */
export function workPace(day: DayInfo, t: number): number {
  return 1 - 0.72 * stormAt(day, t);
}

/* ================== MARKET DAY — where the stalls go ====================== *
 * A market is the one rare day that is a *place* as well as a time, so unlike
 * the weather it needs geometry. It is still not the generator's business: the
 * terrain bytes of a seed are identical whether or not the valley happens to be
 * holding a market that day, so the pitch is derived here, from the finished
 * map, by a pure function that `gen.ts` has never heard of.
 *
 * Everything below is a fact about a map, not about a snapshot: the timeline
 * decides *when* the town exists and the scene decides when to paint the
 * stalls; this decides only where they would stand.
 * -------------------------------------------------------------------------- */

/** A pitch on the market ground. Not a `PropSpec`: the map does not own these. */
export interface StallSpec {
  id: string;
  gx: number;
  gy: number;
  seed: number;
  accent: string;
}

/**
 * Awning cloth. Deliberately NOT the town's accent: the traders came up the
 * road from somewhere else this morning, and a stall in the town's own colour
 * reads as one more building instead of as the reason everyone is out.
 */
const CLOTH = ['#ef7f93', '#f0c75e', '#6cc4d9'];

const SALT_MARKET = 0x3a1e5da7;
const SALT_FIRE = 0xb0f1e1c5;
const TAU = Math.PI * 2;

/** Distance from a point to a segment, in tile units. */
function segDist(px: number, py: number, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a[0] + dx * t), py - (a[1] + dy * t));
}

function polyDist(px: number, py: number, pts: Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = segDist(px, py, pts[i - 1], pts[i]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * The town the market comes to: the biggest one on the map.
 *
 * Biggest by roofs, because that is what a market follows — the town with the
 * most people in it by evening — with the radius and then founding order as
 * tie-breaks so the answer never depends on array iteration luck.
 */
export function marketSite(map: GenesisMap): SiteSpec | null {
  let best: SiteSpec | null = null;
  for (const s of map.sites) {
    if (
      !best ||
      s.buildings.length > best.buildings.length ||
      (s.buildings.length === best.buildings.length && s.radius > best.radius)
    ) {
      best = s;
    }
  }
  return best;
}

interface Clearance {
  /** Trees near enough to matter, prefiltered once. */
  trees: Vec2[];
  site: SiteSpec;
  map: GenesisMap;
}

function clearanceFor(map: GenesisMap, site: SiteSpec): Clearance {
  const reach = site.radius + 4;
  const trees: Vec2[] = [];
  for (const t of map.trees) {
    if (Math.abs(t.gx - site.gx) < reach && Math.abs(t.gy - site.gy) < reach) {
      trees.push([t.gx, t.gy]);
    }
  }
  return { trees, site, map };
}

/**
 * How much room a point has, or `-Infinity` where it has none at all.
 *
 * Deliberately mostly *soft*. A town at the centre of its own glade is a busy
 * place — nine roofs, a dozen bits of dressing and two hundred trees within
 * five tiles of the middle — and a placement that hard-rejects everything it
 * dislikes finds nothing at all on a third of maps. So the only outright
 * refusals are the ones that would look broken (a stall in the river, a stall
 * on the road surface, a stall inside a house) and everything else is a
 * preference the best-of-N search trades off. There is therefore always an
 * answer, and on an open green it is the answer you would have picked.
 *
 * `roadWant` is the distance from a road the caller would *like*: a market
 * pitch wants to be a couple of tiles off the lane, because the trade is on the
 * lane and the stall is beside it; a bonfire wants room on every side.
 */
function openness(
  c: Clearance,
  gx: number,
  gy: number,
  taken: Vec2[],
  roadWant: number,
  room = 2.5
): number {
  const { map, site } = c;

  let dBuild = Infinity;
  for (const b of site.buildings) {
    // `b.w` is the sprite's width in art pixels and a tile is 32 of those, so
    // the footprint radius is a bit over half of `w / 32` tiles.
    const d = Math.hypot(gx - b.gx, gy - b.gy) - (0.7 + b.w / 46);
    if (d < dBuild) dBuild = d;
  }
  if (dBuild < 0.35) return -Infinity;

  for (const o of taken) {
    if (Math.hypot(gx - o[0], gy - o[1]) < 1.7) return -Infinity;
  }

  let dRoad = Infinity;
  for (const r of map.roads) {
    const d = polyDist(gx, gy, r.pts) - r.width * 0.5;
    if (d < dRoad) dRoad = d;
  }
  if (dRoad < 0.9) return -Infinity;

  if (polyDist(gx, gy, map.river) - map.riverWidth * 0.5 < 1.4) return -Infinity;
  for (const lk of map.lakes ?? []) {
    // Lake axes are in screen-aligned (u, v), so the test has to be too.
    const du = gx - gy - (lk.gx - lk.gy);
    const dv = gx + gy - (lk.gx + lk.gy);
    const cs = Math.cos(-lk.rot);
    const sn = Math.sin(-lk.rot);
    const a = (du * cs - dv * sn) / Math.max(0.5, lk.rx);
    const b = (du * sn + dv * cs) / Math.max(0.5, lk.ry);
    if (a * a + b * b < 1.25) return -Infinity;
  }

  let dTree = Infinity;
  for (const t of c.trees) {
    const d = Math.hypot(gx - t[0], gy - t[1]);
    if (d < dTree) dTree = d;
  }
  // Standing in a trunk is the one tree case that looks broken rather than
  // merely tight; everything past it is a preference below.
  if (dTree < 0.75) return -Infinity;
  let dProp = Infinity;
  for (const p of site.props) {
    const d = Math.hypot(gx - p.gx, gy - p.gy);
    if (d < dProp) dProp = d;
  }

  // `room` is how much clear ground the thing being placed actually uses: a
  // stall is a stall's width, a bonfire is a bonfire plus the ring of people
  // standing round it, and asking for that up front is cheaper than discovering
  // afterwards that half the crowd is standing inside somebody's barn.
  return (
    Math.min(dTree, room * 0.7) * 2.0 +
    Math.min(dBuild, room) * 1.3 +
    Math.min(dProp, 1.8) * 0.6 -
    Math.min(Math.abs(dRoad - roadWant), 4) * 0.8
  );
}

/**
 * Where the market pitches, on a map that is having one.
 *
 * Two to four stalls on the open ground of the biggest town, near enough to a
 * road to be trading off it and never on one, on it, or in the river. Pure in
 * `map` alone — the same seed pitches the same market at every pace, on every
 * reload, in every browser.
 */
export function marketStalls(map: GenesisMap): StallSpec[] {
  const site = marketSite(map);
  if (!site) return [];
  const rng = mulberry32(((map.seed >>> 0) ^ SALT_MARKET) >>> 0);
  const n = 2 + Math.floor(rng() * 3);
  const c = clearanceFor(map, site);
  const taken: Vec2[] = [];
  const out: StallSpec[] = [];

  for (let k = 0; k < n; k++) {
    let best: Vec2 | null = null;
    let bestScore = -Infinity;
    // The first stall finds the market ground; the rest pitch next to it,
    // because a market is a cluster and four stalls spread round the rim of a
    // town read as four sheds. A fixed number of candidates whatever happens,
    // so the draw count — and every stall after this one — never depends on
    // what the terrain did or did not allow.
    // The last third of the candidates go back to sampling the whole green, so
    // a hub that turns out to be boxed in by trees still gets its neighbours.
    const hub = taken[0];
    for (let i = 0; i < 120; i++) {
      const near = hub && i < 80;
      const a = rng() * TAU;
      const r = near ? 1.9 + rng() * 1.9 : site.radius * (0.45 + rng() * 0.75);
      const gx = (near ? hub[0] : site.gx) + Math.cos(a) * r;
      const gy = (near ? hub[1] : site.gy) + Math.sin(a) * r;
      // Kept inside the town's own ground: a market on the far side of the
      // wood is a market nobody can see from the road.
      const out0 = Math.hypot(gx - site.gx, gy - site.gy) - site.radius;
      const s = openness(c, gx, gy, taken, 2.5) - Math.max(0, out0) * 1.1;
      if (s > bestScore) {
        bestScore = s;
        best = [gx, gy];
      }
    }
    const seed = Math.floor(rng() * 1e9);
    if (!best) continue;
    taken.push(best);
    out.push({
      id: `mk${k}`,
      gx: Math.round(best[0] * 4) / 4,
      gy: Math.round(best[1] * 4) / 4,
      seed,
      accent: CLOTH[(k + Math.floor(seed / 7)) % CLOTH.length],
    });
  }
  return out;
}

/**
 * Where the festival fire is built: the founding town's own open ground.
 *
 * Not the market town — the festival is the valley's *first* town celebrating
 * that the whole day's work is finished, and that is where the day started.
 */
export function festivalFire(map: GenesisMap): Vec2 | null {
  const site = map.sites[0];
  if (!site) return null;
  const rng = mulberry32(((map.seed >>> 0) ^ SALT_FIRE) >>> 0);
  const c = clearanceFor(map, site);
  let best: Vec2 | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 200; i++) {
    const a = rng() * TAU;
    const r = site.radius * (0.3 + rng() * 0.72);
    const gx = site.gx + Math.cos(a) * r;
    const gy = site.gy + Math.sin(a) * r;
    // A bonfire is the fire plus the ring of people standing round it, so it
    // asks for four clear tiles and a wide berth from the road, and it stays
    // inside the town's own ground because the bunting is strung between the
    // roofs and the two want to be in the same photograph.
    const s = openness(c, gx, gy, [], 4, 4.2) - Math.max(0, r - site.radius) * 1.4;
    if (s > bestScore) {
      bestScore = s;
      best = [gx, gy];
    }
  }
  return best ? [Math.round(best[0] * 4) / 4, Math.round(best[1] * 4) / 4] : null;
}
