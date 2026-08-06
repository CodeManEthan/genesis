/**
 * Genesis — rare days, and the turning of the year.
 *
 * Two small pure questions about a seed, kept away from everything that
 * answers them:
 *
 *   what *kind* of day is this?   Most are ordinary. About one in three draws
 *                                 something: mist that burns off by nine, an
 *                                 eclipse at two in the afternoon, a storm that
 *                                 stops the crews for a couple of hours, an
 *                                 aurora after half past nine, a night with
 *                                 stars falling out of it, a river up over its
 *                                 banks or down to a thread between the stones
 *                                 — or a market, which is the one that is not
 *                                 weather at all.
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

export type DayType =
  | 'normal'
  | 'mist'
  | 'eclipse'
  | 'storm'
  | 'aurora'
  | 'market'
  // APPENDED, never inserted — see TABLE. A night with something falling out of
  // it, and the two days the river is the wrong size.
  | 'stars'
  | 'flood'
  | 'drought';
export type Season = 'winter' | 'spring' | 'summer' | 'autumn';

export interface DayInfo {
  type: DayType;
  season: Season;
  /** The phenomenon's window, in hours. `0..0` on an ordinary day. */
  from: number;
  to: number;
}

/**
 * Frequencies. The rarest is still better than one in forty, which is often
 * enough that a week of browsing finds it.
 *
 * THIS TABLE IS APPEND-ONLY, and that is the whole discipline of the module.
 * It is walked cumulatively from the top, so a row added to the *end* can only
 * ever claim seeds that used to roll `normal` — every mist day, storm day,
 * aurora day, eclipse day and market day in the archive is still exactly the
 * day it was, and always will be. Inserting a row (or changing a probability
 * anywhere but the last row) re-cuts every boundary below it and silently
 * rewrites the past. The only free tuning knob is the LAST row's number.
 *
 * Running total after the three appended below: 0.334 — one day in three is
 * something, across nine kinds of something.
 */
const TABLE: [DayType, number][] = [
  ['mist', 0.06],
  ['storm', 0.06],
  ['aurora', 0.05],
  ['eclipse', 0.03],
  // MARKET — appended, never inserted; the one rare day that is not weather.
  ['market', 0.035],
  // STARS / FLOOD / DROUGHT — appended in this order and no other. One in
  // thirty each, which is about eclipse-rare: rare enough to be a find, common
  // enough that a fortnight of ‹ › turns one up.
  ['stars', 0.033],
  ['flood', 0.033],
  ['drought', 0.033],
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
 * EXACTLY THREE DRAWS, on every branch, for every type there will ever be: the
 * roll, and the two numbers `a` and `b` that shape the window. A new type must
 * take its window out of those two and no others — the moment one branch draws
 * a third, the stream stops being a fixed-shape stream and the numbers a seed
 * has always had start depending on which branch it took.
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
  return windowFor(type, a, b);
}

/**
 * When a day of kind `type` happens, given the two window numbers.
 *
 * Split out of `dayTypeOf` so that the dev-only `?day=` override can ask for a
 * *different* kind of day on the same seed without reimplementing any of this —
 * which is how the flood and drought rivers get photographed at the same bend
 * of the same valley. The lottery above is the only thing that decides what
 * kind of day a seed really is.
 */
function windowFor(type: DayType, a: number, b: number): { type: DayType; from: number; to: number } {
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
    // STARS — once it is properly dark, and then all the way out, like the
    // aurora. A shower does not stop; the valley goes to bed.
    case 'stars':
      return { type, from: 21.5 + a * 0.6, to: 24 };
    /* FLOOD and DROUGHT are the odd ones out, and it is worth being exact
     * about what their window means. The water is the wrong size ALL DAY —
     * a river is baked into the terrain, and the terrain is baked once at
     * midnight, so there is no hour at which the flood arrives or the drought
     * breaks. `from`/`to` are therefore not the phenomenon's window but the
     * hours the valley TALKS about it: the morning somebody walks down to the
     * crossing and finds it gone, and the evening they write it up. Nothing
     * else reads them, and nothing else should. */
    case 'flood':
      return { type, from: 5.6 + a * 0.9, to: 16.4 + b * 1.3 };
    case 'drought':
      return { type, from: 6.3 + a * 0.9, to: 15.8 + b * 1.5 };
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

/** Every kind of day there is, in lottery order. For the dev override and the
 * harnesses; nothing in the world reads it. */
export const DAY_TYPES: DayType[] = ['normal', ...TABLE.map(([k]) => k)];

/**
 * DEV ONLY — what this seed's day would look like if it were a `type` day.
 *
 * The window comes off the seed's own two window draws, so a forced day is the
 * day this valley would have had rather than an invented one, and it is stable:
 * the same `?day=flood&seed=47` is the same flood every time. The lottery is
 * untouched — this is a camera, not a coin.
 */
export function dayOfType(seed: number, type: DayType, month: number | null = null): DayInfo {
  const r = mulberry32(((seed >>> 0) ^ SALT_TYPE) >>> 0);
  r();
  const a = r();
  const b = r();
  return { ...windowFor(type, a, b), season: seasonOf(seed, month) };
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

/**
 * Shooting stars: how much of the shower there is, 0..1. Same shape as the
 * aurora — it fades up as the sky finishes darkening and then simply stays,
 * because what varies over a meteor night is not the brightness of the sky but
 * how recently something went across it, and that is the renderer's clock's
 * business rather than the hour's.
 */
export function starsAt(day: DayInfo, t: number): number {
  if (day.type !== 'stars' || t < day.from) return 0;
  return smooth((t - day.from) / 0.8);
}

/* ============================ FLOOD and DROUGHT ========================== *
 * The two rare days that are not in the sky, and the one thing they are
 * allowed to be.
 *
 * A flood day and a drought day are PRESENTATION AND NARRATION and nothing
 * else: a different-looking river baked into the terrain at midnight, some
 * wreckage going past on it, and a ledger with an opinion. They deliberately do
 * NOT move a crossing, add a ford, delete a bridge or re-route a road — a map
 * that changed shape on a flood day would be a *different valley* for that
 * seed, and the archive's whole promise is that seed 4711 is seed 4711 in
 * January and in July, in the rain and in the sun.
 *
 * So the entire mechanism is the struct below: three multipliers the scene's
 * river bake reads, and an identity value for every other day there has ever
 * been. `CALM_RIVER` is the byte-identity proof — on any day that is not one of
 * these two, the bake multiplies by one, one and one and lays down exactly the
 * pixels it laid down before this feature existed.
 * ------------------------------------------------------------------------- */

export interface RiverMood {
  /** null on every ordinary day, which is what keeps the bake identical. */
  kind: 'flood' | 'drought' | null;
  /** Multiplier on the half-width the WATER is painted at. */
  water: number;
  /** Multiplier on the half-width the BANKS are painted at. */
  bank: number;
  /** Foam flecks per river segment, relative to an ordinary day's nine. */
  foam: number;
}

/** An ordinary river. Frozen so a caller cannot make one day's water sticky. */
export const CALM_RIVER: RiverMood = Object.freeze({
  kind: null,
  water: 1,
  bank: 1,
  foam: 1,
});

/**
 * How today's river is painted.
 *
 * Flood: the water goes out well past its own banks and takes a smear of silt
 * with it, and there is a great deal more of it moving. Drought: the water
 * pulls back to a thread down the middle of a channel that stays exactly where
 * it was — which is the point, because the exposed bed either side is the whole
 * picture, and it can only be exposed if the banks do not move with it.
 */
export function riverMood(day: DayInfo): RiverMood {
  if (day.type === 'flood') return { kind: 'flood', water: 1.6, bank: 1.62, foam: 2.4 };
  if (day.type === 'drought') return { kind: 'drought', water: 0.4, bank: 1, foam: 0.34 };
  return CALM_RIVER;
}

/** Tiles a second the wreckage travels on a flood. A brisk walk. */
export const FLOOD_DRIFT = 0.55;

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

/* ========================================================================== *
 * THE PROSPECTOR, and the one day in twenty he finds something (additive)    *
 * -------------------------------------------------------------------------- *
 * Two more pure questions about a seed, on the same terms as everything above
 * them: derived streams, DOM-free, and answered identically under bare node and
 * in the browser. Nothing here touches the day-type lottery — a gold-strike day
 * is orthogonal to the weather and composes with any of it. A market day can be
 * a gold day; so can a storm.
 *
 * They live in this module rather than in the renderer because the TIMELINE
 * needs one of them: the ledger names the town nearest the strike, and the
 * ledger is built under bare node with no canvas in sight. `scene.ts` and
 * `timeline.ts` both import from here already, which is what keeps the two of
 * them agreeing about which town wakes up rich.
 *
 * The prospector's position is an ANALYTIC function of the hour — no
 * integration, no accumulated state, no reset hook. That is the whole reason a
 * scrub works: at 11:20 he is where 11:20 puts him, whether the visitor got
 * there by watching or by dragging the scrubber backwards through the morning.
 * ========================================================================== */

/** Salts. Distinct from every other salt in the codebase, deliberately. */
const SALT_PAN = 0x7ba17bed;
const SALT_GOLD = 0x901dd05e;

/** His working day: on the water a little before the crews, off it at dusk. */
const PAN_FROM = 6.4;
const PAN_TO = 19.4;
/** How much of each bar's slot he spends kneeling rather than wading on. */
const PAN_DWELL = 0.74;
/** Tiles of river he works between dawn and dusk. */
const PAN_MIN = 10;
const PAN_MAX = 20;

/** One seed in twenty turns up colour. */
const GOLD_CHANCE = 1 / 20;
/** …and never before the afternoon, never after the light starts going. */
export const GOLD_FROM = 13.0;
export const GOLD_TO = 16.5;

/**
 * The beat he works: a stretch of one bank, and the arclength table that turns
 * an hour into a place on it.
 */
export interface ProspectorPath {
  pts: Vec2[];
  cum: number[];
  len: number;
  /** Arclength he starts the day at, and the signed distance he covers. */
  s0: number;
  span: number;
  /** Which bank he kneels on: the sign of the river normal he stands off. */
  side: 1 | -1;
  /** How many gravel bars he works between dawn and dusk. */
  bars: number;
  /** How far off the centreline he kneels, in tiles. */
  off: number;
  /** A colour for his coat, picked once. */
  color: string;
}

/** Where he is, and what he is doing about it. */
export interface ProspectorPose {
  gx: number;
  gy: number;
  /** 1 kneeling at a bar, 0 wading to the next one. */
  work: 0 | 1;
  /** Facing right on screen. */
  face: boolean;
}

function panCum(pts: Vec2[]): { cum: number[]; len: number } {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return { cum, len: cum[cum.length - 1] || 1 };
}

/** Point and unit tangent at arclength `s` along a polyline. */
function panPoint(
  pts: Vec2[],
  cum: number[],
  len: number,
  s: number
): [number, number, number, number] {
  const d = s < 0 ? 0 : s > len ? len : s;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const f = (d - cum[i - 1]) / seg;
  const ax = pts[i - 1][0];
  const ay = pts[i - 1][1];
  const dx = pts[i][0] - ax;
  const dy = pts[i][1] - ay;
  const L = Math.hypot(dx, dy) || 1;
  return [ax + dx * f, ay + dy * f, dx / L, dy / L];
}

/** Coats, a subset of the crowd's own palette so he reads as one of them. */
const PAN_COLORS = ['#c8a86a', '#9aa3ad', '#a9743e', '#6cc4d9'];

/**
 * The stretch of river this valley's prospector works today, or null if there
 * is no river worth kneeling in.
 *
 * "Upstream" is taken to be whichever end of the river sits further UP THE
 * SCREEN. There is no flow direction in the map data and there does not need to
 * be one: in an isometric valley the far end reads as the head of the water, so
 * walking towards it reads as walking upstream, which is the only thing this
 * has to get right.
 */
export function prospectorPath(map: GenesisMap): ProspectorPath | null {
  const pts = map.river ?? [];
  if (pts.length < 2) return null;
  const { cum, len } = panCum(pts);
  if (len < 6) return null;

  const rng = mulberry32(((map.seed >>> 0) ^ SALT_PAN) >>> 0);
  // isoY is monotone in (gx + gy), so this comparison is the screen one.
  const head = pts[0];
  const tail = pts[pts.length - 1];
  const up = tail[0] + tail[1] < head[0] + head[1] ? 1 : -1;

  const lo = len * 0.06;
  const hi = len * 0.94;
  const room = Math.max(1, hi - lo);
  const dist = Math.min(PAN_MIN + rng() * (PAN_MAX - PAN_MIN), room);
  const slack = Math.max(0, room - dist);
  const s0 = up > 0 ? lo + rng() * slack : lo + dist + rng() * slack;

  return {
    pts,
    cum,
    len,
    s0,
    span: up * dist,
    side: rng() < 0.5 ? 1 : -1,
    bars: 8 + Math.floor(rng() * 5),
    // Half the channel plus a boot's width, so he is in the shallows at the
    // edge of the water rather than out in the middle of the river.
    off: (map.riverWidth ?? 0.95) * 0.5 + 0.45,
    color: PAN_COLORS[Math.floor(rng() * PAN_COLORS.length)],
  };
}

/**
 * Where he is at hour `t`, or null when he is not out.
 *
 * The day is cut into `bars` equal slots. He spends the first three quarters of
 * each one kneeling in the same place and the rest of it wading up to the next,
 * which from across the valley is a man who moves about once an hour and
 * otherwise does not move at all — which is what panning looks like.
 */
export function prospectorAt(path: ProspectorPath, t: number): ProspectorPose | null {
  if (t < PAN_FROM || t >= PAN_TO) return null;
  const k = (t - PAN_FROM) / (PAN_TO - PAN_FROM);
  const u = k * path.bars;
  const i = Math.min(path.bars - 1, Math.floor(u));
  const f = u - i;
  let step = i;
  if (f > PAN_DWELL) {
    const e = (f - PAN_DWELL) / (1 - PAN_DWELL);
    step = i + e * e * (3 - 2 * e); // smoothstep: he sets off and settles again
  }
  const s = path.s0 + (path.span * step) / path.bars;
  const [px, py, tx, ty] = panPoint(path.pts, path.cum, path.len, s);
  const nx = -ty * path.side;
  const ny = tx * path.side;
  // Screen x runs with (gx - gy), so that is the sign that decides which way he
  // is facing while he wades.
  const dir = path.span > 0 ? 1 : -1;
  return {
    gx: px + nx * path.off,
    gy: py + ny * path.off,
    work: f > PAN_DWELL ? 0 : 1,
    face: (tx - ty) * dir > 0,
  };
}

/** The day's strike: when, where, and who is going to hear about it. */
export interface GoldStrike {
  at: number;
  gx: number;
  gy: number;
  site: SiteSpec | null;
}

/**
 * Is this one of the days? One seed in twenty, off its own stream, so it can
 * land on a mist day, a market day or an ordinary Tuesday with equal ease and
 * without moving a single tree, stall or cloud on any of them.
 */
export function goldStrike(map: GenesisMap): GoldStrike | null {
  const rng = mulberry32(((map.seed >>> 0) ^ SALT_GOLD) >>> 0);
  if (rng() >= GOLD_CHANCE) return null;
  const at = GOLD_FROM + rng() * (GOLD_TO - GOLD_FROM);
  const path = prospectorPath(map);
  if (!path) return null;
  const pose = prospectorAt(path, at);
  if (!pose) return null;

  // The nearest town to the gravel bar, with the id as an explicit tie-break so
  // the answer never depends on array iteration luck.
  let site: SiteSpec | null = null;
  let best = Infinity;
  for (const s of map.sites) {
    const d = Math.hypot(s.gx - pose.gx, s.gy - pose.gy);
    if (d < best || (d === best && site && s.id < site.id)) {
      best = d;
      site = s;
    }
  }
  return { at, gx: pose.gx, gy: pose.gy, site };
}

/* ---- end the prospector (additive) --------------------------------------- */

/* ==================== town rivalries (additive) =========================== *
 * Two towns decide, on their own and for no good reason, that today is a race.
 *
 * NOTHING IN THE WORLD CHANGES. No plot moves, no crew hurries, no event shifts
 * by a minute; the two towns build exactly the day they were always going to
 * build. The rivalry is a story the valley tells about a schedule it already
 * had — a wager laid over work in progress, a running score, and somebody
 * paying up at the end. That is the whole feature, and the reason it is safe.
 *
 * This half is the *decision*: is there a race today, and between whom. It
 * lives here rather than in `timeline.ts` for the same reason `marketSite` and
 * `goldStrike` do — it is a pure question about a map, answered off its own
 * derived stream, so asking it cannot move anything that was already rolled.
 * `timeline.ts` owns the other half: the hours, and the words.
 * -------------------------------------------------------------------------- */

const SALT_RIVAL = 0x72495641; // 'rIVA'

/** How often two towns fall out over nothing. Rolled first, before the map is
 * inspected at all, so this is a property of the SEED; the qualifying tests
 * below then turn some of those days back into ordinary ones. */
const RIVALRY_CHANCE = 0.28;

/**
 * A town has to have enough of a day ahead of it to lose a race in. Three roofs
 * is the floor: it is the first score milestone, and a two-plot hamlet racing
 * anybody reads as a joke rather than a rivalry.
 */
const RIVAL_MIN_ROOFS = 3;

/**
 * The day's grudge: who, and how many roofs the first score line waits for.
 *
 * `a` and `b` are in ROSTER order and nothing more. Which of them sets the mark
 * and which one goes at it is a question about the finished schedule, not about
 * the map, so `timeline.ts` works that out for itself from the first frame each
 * one gets in the ground.
 */
export interface Rivalry {
  /** the earlier in the roster, which is founding order */
  a: SiteSpec;
  /** the later */
  b: SiteSpec;
  /** roofs on the board before the ledger says the score out loud */
  mark: number;
}

/** Roofs this town actually raises today. The founding homestead's first house
 * is standing at midnight and is nobody's achievement. */
function roofsPlanned(map: GenesisMap, s: SiteSpec): number {
  const n = s.buildings.length;
  return map.sites.length && map.sites[0].id === s.id ? n - 1 : n;
}

/**
 * Is today a race, and between which two towns?
 *
 * Neighbours read better than strangers, so the candidates are the pairs the
 * ROAD NETWORK already joined — two towns at opposite corners of the valley
 * have no way of knowing what the other is up to, let alone of betting on it.
 * Only if the roads join no qualifying pair at all does it fall back to the
 * nearest two, which is the same relationship by a different route.
 *
 * Deterministic throughout: candidate pairs are built in a fixed order and
 * sorted by roster index, so the choice never depends on iteration luck.
 */
export function rivalryOf(map: GenesisMap): Rivalry | null {
  const sites = map.sites;
  if (sites.length < 2) return null;

  const rng = mulberry32(((map.seed >>> 0) ^ SALT_RIVAL) >>> 0);
  if (rng() >= RIVALRY_CHANCE) return null;

  const idx = new Map<string, number>();
  sites.forEach((s, i) => idx.set(s.id, i));
  const big = sites.map((s) => roofsPlanned(map, s) >= RIVAL_MIN_ROOFS);

  /* --- pairs the roads already introduced -------------------------------- */
  const pairs: [number, number][] = [];
  const seen = new Set<string>();
  for (const r of map.roads) {
    const i = idx.get(r.from);
    const j = idx.get(r.to);
    if (i === undefined || j === undefined || i === j) continue;
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    if (!big[lo] || !big[hi]) continue;
    const k = `${lo}:${hi}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pairs.push([lo, hi]);
  }

  /* --- or, failing that, the two nearest towns that qualify --------------- */
  // Strict `<`, walked in roster order, so a tie in distance goes to the pair
  // that was founded earliest rather than to whichever the loop met first.
  if (!pairs.length) {
    let best = Infinity;
    let pick: [number, number] | null = null;
    for (let i = 0; i < sites.length; i++) {
      if (!big[i]) continue;
      for (let j = i + 1; j < sites.length; j++) {
        if (!big[j]) continue;
        const d = Math.hypot(sites[i].gx - sites[j].gx, sites[i].gy - sites[j].gy);
        if (d < best) {
          best = d;
          pick = [i, j];
        }
      }
    }
    if (!pick) return null;
    pairs.push(pick);
  }

  pairs.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
  const [lo, hi] = pairs[Math.floor(rng() * pairs.length)];
  return { a: sites[lo], b: sites[hi], mark: RIVAL_MIN_ROOFS };
}

/* ================== end town rivalries (additive) ========================= */
