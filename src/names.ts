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
 */

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
