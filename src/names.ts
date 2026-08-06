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

/* ---- standing stones (additive) ---- */

/**
 * A town in sight of the stones is named FOR them, and the pools it draws from
 * are these. Same shape as the lists above — a leading element and a trailing
 * one — so a stone name is built by exactly the same machinery, off exactly the
 * same rolls, and only ever looks the numbers up somewhere else.
 *
 * The two tail lists are the SAME LENGTH on purpose: one roll picks the tail,
 * and whether it is welded on (Stanhow, Harrowstone) or stands as its own word
 * (Dolmen Lea, Ring Barton) is decided by a roll the ordinary name was already
 * making anyway.
 */
const STONE_STEMS = [
  'Stan', 'Stane', 'Ring', 'Harrow', 'Hoar', 'Grey', 'Long', 'Dolmen',
  'Cairn', 'Barrow', 'Crom', 'Mene', 'Standing', 'Grim', 'Nine', 'Wayland',
];

/** Welded on: Stanhow, Harrowstone, Greyton. */
const STONE_TAILS = [
  'how', 'stone', 'barton', 'lea', 'henge', 'moor', 'stead', 'ton',
  'gate', 'field', 'ridge', 'combe', 'borough', 'tor', 'wick', 'holt',
];

/** Standing alone: Dolmen Lea, Ring Barton, Wayland Cross. */
const STONE_HEADS = [
  'Barton', 'Lea', 'Ring', 'Cross', 'Rigg', 'Fold', 'Green', 'Bank',
  'Holt', 'Combe', 'Moor', 'Rise', 'Hill', 'Row', 'End', 'Field',
];

/* ---- end standing stones (additive) ---- */

/* --------------------------------- helpers -------------------------------- */

const pick = <T,>(rng: () => number, list: readonly T[]): T =>
  list[Math.min(list.length - 1, Math.floor(rng() * list.length))];

/** `pick`, but off a roll somebody else already made. */
const at = <T,>(list: readonly T[], roll: number): T =>
  list[Math.min(list.length - 1, Math.floor(roll * list.length))];

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

/* ---- standing stones (additive) ---- */

/**
 * The raw uniforms behind one attempt at a town name, in draw order:
 *
 *   [0] stem   [1] suffix   [2] the modifier gate   [3] the modifier, if drawn
 *
 * Recording them is the whole trick behind stone-named towns. A town by the
 * monument must not cost the naming stream a single extra draw, or every town
 * after it in the roster would be renamed and the map would stop being a pure
 * function of its seed in the way the subset check pins down. So the stones
 * never roll anything: they take the rolls the ordinary name had already made
 * and look them up in a different set of word lists.
 */
export type NameRolls = readonly number[];

/** One attempt at a name, and the rolls it came off. */
export interface NameDraw {
  name: string;
  rolls: number[];
}

/** `townName`, with the rolls kept. The draw sequence is identical. */
function rollTownName(rng: () => number): NameDraw {
  const rolls: number[] = [];
  const roll = () => {
    const x = rng();
    rolls.push(x);
    return x;
  };
  const stem = at(STEMS, roll());
  const suffix = at(SUFFIXES, roll());
  const base = join(stem, suffix);
  const name = roll() < 0.14 ? `${at(MODIFIERS, roll())} ${base}` : base;
  return { name, rolls };
}

/**
 * The same name, told by the stones: "Stanhow", "Dolmen Lea", "Harrowstone",
 * "Nether Ring Barton". Pure — it makes no draws at all.
 *
 * `used` is every other name on the map. A collision walks the tail index on
 * by one, which is deterministic and still in the pool; if the whole pool is
 * somehow spoken for, the town keeps the name it already had.
 */
export function stoneTownName(
  rolls: NameRolls,
  used: ReadonlySet<string>,
  fallback: string
): string {
  if (rolls.length < 3) return fallback;
  const si = Math.min(STONE_STEMS.length - 1, Math.floor(rolls[0] * STONE_STEMS.length));
  const ti = Math.min(STONE_TAILS.length - 1, Math.floor(rolls[1] * STONE_TAILS.length));
  // The modifier gate does double duty: below 0.5 the tail welds on, above it
  // the tail stands as its own word. Same roll, a second question asked of it.
  const welded = rolls[2] < 0.5;
  const mod = rolls.length > 3 ? at(MODIFIERS, rolls[3]) : '';
  for (let k = 0; k < STONE_TAILS.length; k++) {
    const j = (ti + k) % STONE_TAILS.length;
    const base = welded
      ? join(STONE_STEMS[si], STONE_TAILS[j])
      : `${STONE_STEMS[si]} ${STONE_HEADS[j]}`;
    const name = mod ? `${mod} ${base}` : base;
    if (!used.has(name)) return name;
  }
  return fallback;
}

/* ---- end standing stones (additive) ---- */

/** A town name: "Alderford", "Bramblemere", "Nether Foxholt". */
export function townName(rng: () => number): string {
  return rollTownName(rng).name;
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
  return townNamesDrawn(rng, n, used).map((d) => d.name);
}

/* ---- standing stones (additive) ---- */

/**
 * `townNames`, with each name's rolls kept alongside it — see `NameRolls`.
 * `townNames` is now a thin wrapper over this, so there is exactly one naming
 * code path and the two cannot drift apart by a single draw.
 */
export function townNamesDrawn(
  rng: () => number,
  n: number,
  used = new Set<string>()
): NameDraw[] {
  const out: NameDraw[] = [];
  for (let i = 0; i < n; i++) {
    let d = rollTownName(rng);
    for (let tries = 0; tries < 200 && used.has(d.name); tries++) d = rollTownName(rng);
    // Absolute fallback — deterministic and still readable.
    if (used.has(d.name)) {
      d = { name: `${d.name} ${['Magna', 'Parva', 'Green', 'End'][i % 4]}`, rolls: d.rolls };
    }
    used.add(d.name);
    out.push(d);
  }
  return out;
}

/* ---- end standing stones (additive) ---- */

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
