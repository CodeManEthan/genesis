/**
 * Genesis — rare days, and the turning of the year.
 *
 * Two small pure questions about a seed, kept away from everything that
 * answers them:
 *
 *   what *kind* of day is this?   Most are ordinary. About one in five draws a
 *                                 weather: mist that burns off by nine, an
 *                                 eclipse at two in the afternoon, a storm that
 *                                 stops the crews for a couple of hours, or an
 *                                 aurora after half past nine.
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

import { mulberry32 } from './types.ts';

export type DayType = 'normal' | 'mist' | 'eclipse' | 'storm' | 'aurora';
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
