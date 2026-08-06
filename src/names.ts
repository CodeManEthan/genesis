/**
 * Genesis — seeded place names.
 *
 * Cozy English-countryside compounds: a nature/word stem plus a settlement
 * suffix (Alderford, Bramblemere, Foxholt, Wrenfield, Millbeck …). The lists
 * are deliberately large — 60 stems x 34 suffixes is ~2000 base combinations,
 * so a 5-7 town map collides only rarely, and gen.ts retries on collision to
 * guarantee uniqueness inside one map.
 *
 * Pure and DOM-free: every roll comes from the caller's mulberry32 stream.
 *
 * The founders block at the bottom is the one exception, and only in that it
 * seeds its OWN stream rather than borrowing the caller's — see the note there.
 */

/* ---- founders (additive) ---- */
import { mulberry32 } from './types.ts';
/* ---- end founders (additive) ---- */

/* -------------------------------- word parts ------------------------------ */

/** Leading element. Mostly hedgerow flora, small birds, and old land words. */
const STEMS = [
  'Alder', 'Ash', 'Aspen', 'Barrow', 'Beech', 'Bell', 'Bram', 'Bramble',
  'Brack', 'Briar', 'Brock', 'Chad', 'Clover', 'Cobb', 'Coppice', 'Dray',
  'Dun', 'Elder', 'Ever', 'Fern', 'Finch', 'Fox', 'Glen', 'Gorse',
  'Harrow', 'Haw', 'Hazel', 'Heather', 'Holly', 'Ivy', 'Kestrel', 'Lark',
  'Linden', 'Maple', 'Marl', 'Mill', 'Nettle', 'Oak', 'Osier', 'Otter',
  'Pebble', 'Pipp', 'Quill', 'Rook', 'Rowan', 'Rush', 'Sedge', 'Sorrel',
  'Sparrow', 'Stone', 'Tarn', 'Teasel', 'Thistle', 'Thorn', 'Willow', 'Wold',
  'Wren', 'Yarrow', 'Yew', 'Merle',
];

/** Trailing settlement element. */
const SUFFIXES = [
  'ford', 'mere', 'holt', 'field', 'beck', 'wick', 'bury', 'combe',
  'dale', 'den', 'ley', 'thorpe', 'stead', 'worth', 'hollow', 'gate',
  'moor', 'ridge', 'brook', 'shaw', 'ton', 'cot', 'marsh', 'bridge',
  'fold', 'hurst', 'well', 'croft', 'barrow', 'haven', 'stow', 'wold',
  'garth', 'lea',
];

/** Occasional modifier word, ~1 name in 7. */
const MODIFIERS = ['Little', 'Great', 'Old', 'Nether', 'Upper', 'Lower', 'West', 'East'];

/** Second element for valley names ("Wrenmoor Dale"). */
const VALE_ELEMENTS = [
  'moor', 'mere', 'brook', 'wold', 'shaw', 'combe', 'fell', 'water',
  'hollow', 'reach', 'marsh', 'wood',
];

/** Head nouns for a valley. */
const VALE_NOUNS = ['Vale', 'Dale', 'Hollow', 'Bottom', 'Reach', 'Glen', 'Combe'];

/* --------------------------------- helpers -------------------------------- */

const pick = <T,>(rng: () => number, list: readonly T[]): T =>
  list[Math.min(list.length - 1, Math.floor(rng() * list.length))];

/**
 * Join a stem to a suffix, collapsing a doubled letter at the seam so we get
 * "Milley" rather than "Millley" and "Thornridge" rather than "Thornnridge".
 */
function join(stem: string, suffix: string): string {
  const a = stem[stem.length - 1].toLowerCase();
  const b = suffix[0].toLowerCase();
  const head = a === b ? stem.slice(0, -1) : stem;
  return head + suffix;
}

/* ------------------------------- public API ------------------------------- */

/** A town name: "Alderford", "Bramblemere", "Nether Foxholt". */
export function townName(rng: () => number): string {
  const stem = pick(rng, STEMS);
  const suffix = pick(rng, SUFFIXES);
  const base = join(stem, suffix);
  return rng() < 0.14 ? `${pick(rng, MODIFIERS)} ${base}` : base;
}

/** A valley name: "The Alder Vale", "Wrenmoor Dale", "The Vale of Foxholt". */
export function valleyName(rng: () => number): string {
  const stem = pick(rng, STEMS);
  const noun = pick(rng, VALE_NOUNS);
  const roll = rng();
  if (roll < 0.28) return `The ${stem} ${noun}`;
  if (roll < 0.56) return `${join(stem, pick(rng, VALE_ELEMENTS))} ${noun}`;
  if (roll < 0.74) return `The ${noun} of ${townName(rng)}`;
  if (roll < 0.88) return `${join(stem, pick(rng, VALE_ELEMENTS))} ${noun}`;
  return `The ${join(stem, pick(rng, VALE_ELEMENTS))}`;
}

/**
 * Convenience for gen.ts: n distinct town names off one stream.
 *
 * Pass a shared `used` set to draw a further batch later that stays distinct
 * from an earlier one — gen.ts needs that to extend its town roster without
 * disturbing the names it already handed out.
 */
export function townNames(rng: () => number, n: number, used = new Set<string>()): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let name = townName(rng);
    for (let tries = 0; tries < 200 && used.has(name); tries++) name = townName(rng);
    // Absolute fallback — deterministic and still readable.
    if (used.has(name)) name = `${name} ${['Magna', 'Parva', 'Green', 'End'][i % 4]}`;
    used.add(name);
    out.push(name);
  }
  return out;
}

/* ======================== founders (additive block) ======================= */
/*
 * Somebody drove the first stake. Every town in the valley gets one name, and
 * it is the name the ledger uses — "Maud drives the first stake at Bellcroft",
 * "Old Wren is not satisfied with the well".
 *
 * Same register as the town morphology above: hedgerow English, a little
 * archaic, no surnames. A settler is Nell or Amos or Wren, and the valley
 * knows which one is meant.
 *
 * SCALE RULE. A founder is keyed on (seed, roster index) through its own
 * derived substream, so the name of town i is the same name at 0.25x as at 4x
 * — the pace control trims the roster, it does not rename what is left. The
 * de-dup below only ever looks BACKWARD, at indices a smaller scale already
 * has, so it cannot move a name either.
 *
 * Nothing here touches the draw sequences of `townName` / `valleyName` /
 * `townNames` above: those are the valley's naming stream and are left exactly
 * as they were.
 */

/** Given names, both genders, deliberately plain and deliberately old. */
const FOUNDER_NAMES = [
  // women
  'Agnes', 'Alys', 'Annis', 'Bess', 'Cissy', 'Dot', 'Edith', 'Ellen',
  'Esme', 'Hannah', 'Hester', 'Jenny', 'Joan', 'Kitty', 'Mabel', 'Maud',
  'Nan', 'Nell', 'Peg', 'Prue', 'Rilla', 'Ruth', 'Sal', 'Tabitha',
  'Winnie', 'Marged',
  // men
  'Amos', 'Bartle', 'Caleb', 'Cuthbert', 'Eli', 'Gil', 'Hal', 'Hob',
  'Jed', 'Jem', 'Josiah', 'Lem', 'Ned', 'Noll', 'Obed', 'Perrin',
  'Rafe', 'Silas', 'Tam', 'Tobias', 'Wat', 'Wilf', 'Zeb', 'Ambrose',
  // either, and straight off the hedgerow — the same words the towns are
  // built out of, which is the point: these people named the places.
  'Wren', 'Linnet', 'Robin', 'Merrit',
];

/** Occasional honorific, ~1 founder in 5. "Old Wren", "Young Nell". */
const FOUNDER_STYLES = ['Old', 'Young', 'Big', 'Little'];

/** The substream salt for founders: 'Fndr'. */
const FOUNDER_SALT = 0x466e6472;

/**
 * One founder, keyed on (seed, roster index) and nothing else.
 *
 * `force` makes the honorific certain rather than occasional, which is the
 * de-dup's second attempt: a valley with two Nells in it has an Old Nell.
 */
function founderAt(seed: number, index: number, force: boolean): string {
  const rng = mulberry32(((seed ^ FOUNDER_SALT) + Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  const base = pick(rng, FOUNDER_NAMES);
  const styled = rng() < 0.2;
  if (!force && !styled) return base;
  return `${pick(rng, FOUNDER_STYLES)} ${base}`;
}

/**
 * Founders for a FULL town roster, in roster order.
 *
 * `n` must be the roster length gen.ts computed against SCALE_MAX, never the
 * trimmed one, or the de-dup would see a different history at a small pace.
 * Since the pass only reads names it has already assigned, the result for
 * index i is a function of (seed, i) alone whatever `n` is — the length only
 * decides where it stops.
 */
export function founderNames(seed: number, n: number): string[] {
  const out: string[] = [];
  const used = new Set<string>();
  for (let i = 0; i < n; i++) {
    // The plain name first; if the valley already has one of those, the same
    // index's stream is asked again with an honorific allowed, which is how
    // a second Nell becomes Old Nell rather than Nell II.
    let name = founderAt(seed, i, false);
    if (used.has(name)) name = founderAt(seed, i, true);
    for (let k = 1; k <= 24 && used.has(name); k++) {
      name = founderAt(seed, i + k * 4096, true);
    }
    // Absolute fallback — deterministic, and still a name.
    if (used.has(name)) name = `${name} the Younger`;
    used.add(name);
    out.push(name);
  }
  return out;
}

/* ====================== end founders (additive block) ==================== */
