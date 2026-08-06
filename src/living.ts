/**
 * Genesis — living details, round two: the pure half.
 *
 * Three things in the valley that CHANGE without anything in the timeline
 * happening at that moment:
 *
 *   a tree half over        the last few minutes of a chop, when the trunk is
 *                           on its hinge and going
 *   a field filling up      haystacks that come one after another through the
 *                           afternoon, each one growing as it is built
 *   a growing timber yard   a lumber pile whose height is the count of the
 *                           axes that have finished within reach of it
 *
 * All three are CONSEQUENCES, not ambient theatre, so all three obey the same
 * rule the rest of the world does: `world = f(seed, t)`. Nothing here keeps a
 * "since last frame" or a "current stage" — every function is total in its
 * arguments, and every argument is either map data, plan data, or `t`. Scrub to
 * 17:00 from either direction and the same hay stands in the same fields.
 *
 * This module is DOM-free and Node-importable (type stripping, hence the `.ts`
 * on the type import) so the harness can check the arithmetic without a canvas.
 * The drawing that hangs off it lives in scene.ts; the sprites in vale/art.ts.
 */

import type { GenesisMap, PropSpec, SiteSpec, Timeline, TreeKind } from './types.ts';
import { mulberry32 } from './types.ts';

/* ============================ half-fallen trees =========================== */

/**
 * How long a tree spends going over: five world-minutes on its hinge, at the
 * END of its own chop.
 *
 * The window is derived from the `chop-done` the plan already carries and from
 * nothing else — no new event, no new snapshot state, no "the frame I noticed".
 * It is deliberately hung off the END of the chop rather than the start,
 * because the start is the one end of the window the renderer can already see
 * (the tree is `felling` from the first blow) and the finish is the one the
 * fall has to line up with: the instant the lean reaches full tilt is the
 * instant `chop-done` puts the stump and the log on the ground.
 *
 * A chop can be shorter than this — a road crew against the head's deadline
 * hurries one down in 24 seconds —
 * and that needs no special case anywhere: the lean is only ever drawn for a
 * tree the snapshot says is `felling`, so a chop shorter than the lean is
 * simply a tree that leans from the first blow.
 */
export const LEAN_FOR = 5 / 60;

/**
 * Where in its fall a tree is at `t`: 0 at the first creak, 1 at the ground,
 * and -1 for a tree that is not going over at all (which is every tree in the
 * valley bar a handful, all day).
 *
 * `cd` is the tree's `chop-done` time, or undefined for a tree the plan never
 * fells — and for every tree at all, on the paths that have no plan to hand
 * (the catalog page, a headless harness). Undefined means "no lean", exactly
 * as `fest = 0` means "no festival": the feature costs one failed comparison
 * and disappears.
 */
export function leanPhase(cd: number | undefined, t: number): number {
  if (cd === undefined) return -1;
  const dt = cd - t;
  // Half-open, and open at the fall: at `cd` itself the snapshot has already
  // put the stump and the log on the ground, so the lean is over by exactly
  // the instant the thing it was leading up to has happened.
  if (dt <= 0 || dt >= LEAN_FOR) return -1;
  return 1 - dt / LEAN_FOR;
}

/**
 * How each kind of tree goes over: the tilt it reaches at the ground, and the
 * shape of the curve it takes to get there.
 *
 * `ease` is the exponent on the phase, so it is entirely a statement about
 * WHEN the tree commits: a fir stands there looking untouched and then goes all
 * at once (3.0), a willow is leaning before anybody has finished the back cut
 * (1.1). `tilt` is the shear at the crown when it lands, in trunk-heights of
 * sideways — a fir has the height to fall a long way, a willow's crown is
 * already halfway to the ground when it starts.
 */
const LEAN_KIND: Record<TreeKind, { tilt: number; ease: number }> = {
  oak: { tilt: 0.62, ease: 2.0 },
  pine: { tilt: 0.78, ease: 2.4 },
  blossom: { tilt: 0.66, ease: 1.7 },
  hedgerow: { tilt: 0.54, ease: 1.8 },
  birch: { tilt: 0.86, ease: 1.4 },
  willow: { tilt: 0.5, ease: 1.1 },
  fir: { tilt: 0.9, ease: 3.0 },
};

/**
 * The shear and the squash to draw a leaning tree with.
 *
 * `k` is a horizontal shear about the foot of the trunk: the base row does not
 * move, and everything above it slides sideways in proportion to its height.
 * That is why it is a shear and not a rotation — the tree's own ground shadow
 * is drawn AT the foot, so a shear leaves it lying flat on the ground where it
 * belongs, and a rotation would tip it up into the air with the crown.
 *
 * `squash` shortens the tree as it goes, which is the height the fall trades
 * for reach; without it a leaning tree reads as a tree that has grown sideways.
 */
export function leanOf(
  kind: TreeKind,
  dir: number,
  phase: number
): { k: number; squash: number } {
  const { tilt, ease } = LEAN_KIND[kind] ?? LEAN_KIND.oak;
  const e = Math.pow(phase, ease);
  return { k: tilt * e * dir, squash: 1 - 0.22 * e };
}

/**
 * Where the trunk lies once it is down, as a bearing and a distance off the
 * stump in tiles.
 *
 * Shared, and NOT inlined at either call site, because the two uses have to
 * agree: the scenery layer puts the felled log here, and the fall leans the
 * tree the same way. A tree that leans east and then lies west is worse than a
 * tree that does not lean at all.
 */
export function logOffset(seed: number): { a: number; d: number } {
  const lr = mulberry32((seed ^ 0x10c17e5d) >>> 0);
  const a = lr() * Math.PI * 2;
  const d = 0.85 + lr() * 0.5;
  return { a, d };
}

/**
 * Which way the tree goes over on the screen: +1 for a fall to the right, -1
 * to the left. Straight out of where the trunk is going to lie — screen x is
 * (gx - gy) * TW/2, so the sign of the tile offset's (dx - dy) is the sign of
 * the sideways move. A trunk that lies dead along the screen's y axis (the
 * sign is 0 to within rounding) falls right, arbitrarily and consistently.
 */
export function leanDir(seed: number): number {
  const { a, d } = logOffset(seed);
  const dx = Math.cos(a) * d - Math.sin(a) * d;
  return dx < 0 ? -1 : 1;
}

/** Every tree the plan takes down, and when it hits the ground. */
export function chopDoneTimes(tl: Timeline): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of tl.events) if (e.type === 'chop-done') m.set(e.treeId, e.t);
  return m;
}

/* ============================ growing haystacks =========================== */

/**
 * The afternoon's hay.
 *
 * Nothing is cut before mid-afternoon and the field goes on filling until the
 * light goes: the first rick of a field stands up between 15:12 and 16:36, and
 * each one after it three quarters of an hour to an hour and a quarter later.
 * That puts the first cut alongside the corn going gold (`CROP_TALL_AT`, 16:00
 * ± 40 minutes, in scene.ts) and the field at its fullest at dusk, which is the
 * whole gesture: a farming town looks BUSIER at six than it did at noon.
 */
const HAY_FROM = 15.2;
const HAY_SPREAD = 1.4;
/** How long between one rick going up and the next in the same field. */
const HAY_EVERY = 0.7;
const HAY_EVERY_SPREAD = 0.6;
/** How long a rick takes to go from a heap of cut hay to a thatched rick. */
const HAY_GROW = 0.5;

/** One haystack: where it stands, when it starts, and what raises it. */
export interface HayPlan {
  gx: number;
  gy: number;
  /** Sprite seed — the pooled rick this one is, at all three of its ages. */
  seed: number;
  /** The hour the first forkful goes down. */
  at: number;
  /**
   * The site-dressing prop this hay hangs off. The timeline has to have raised
   * it before any of the hay exists: a field that is not there yet is not
   * being mown.
   */
  propId: string;
}

/**
 * Every haystack a piece of site dressing is worth, in the order they appear.
 *
 * Two kinds of dressing grow hay, and only these two, which is what "near
 * fields only" means when the valley's fields are props rather than terrain:
 *
 *   a `haystack` prop   is itself the first rick of a field — it stops being a
 *                       thing that is simply there from the moment the timeline
 *                       raises it, and becomes a thing that is cut, at an hour,
 *                       and grows.
 *   a `crop` prop       in a FARMING town gets ricks at the edge of it as the
 *                       corn comes in. Only farming towns: everybody's kitchen
 *                       garden ripens, but only a farming town's fields are
 *                       worked hard enough to fill up with hay.
 *
 * Companions ride the anchor's own seed, so a field's hay is the same hay at
 * every pace and after any scrub; and because the anchor is a prop the
 * generator already placed legally (clear of plots, roads and water), a rick a
 * tile and a half off it on a jittered bearing is somewhere a rick can stand.
 * No new draw comes out of any generator stream — this is all downstream
 * arithmetic on `PropSpec.seed`.
 */
export function hayFor(site: SiteSpec, p: PropSpec): HayPlan[] {
  const isRick = p.kind === 'haystack';
  const isField = p.kind === 'crop' && site.profession === 'farming';
  if (!isRick && !isField) return [];

  const rng = mulberry32((p.seed ^ 0xda75ac1) >>> 0);
  const t0 = HAY_FROM + rng() * HAY_SPREAD;
  // A field carries more hay than a lone rick does, and a farming town's own
  // ricks multiply: one to two companions each, one to three round a field.
  const extra = isField
    ? 2 + Math.floor(rng() * 2)
    : site.profession === 'farming'
      ? 1 + Math.floor(rng() * 2)
      : 0;

  const out: HayPlan[] = [];
  let at = t0;
  if (isRick) out.push({ gx: p.gx, gy: p.gy, seed: p.seed, at, propId: p.id });
  for (let i = 0; i < extra; i++) {
    at += HAY_EVERY + rng() * HAY_EVERY_SPREAD;
    // Round the anchor at a rick's width and a half, on its own bearing.
    const ang = rng() * Math.PI * 2;
    const d = (isField ? 1.9 : 1.15) + rng() * 0.7;
    out.push({
      gx: p.gx + Math.cos(ang) * d,
      gy: p.gy + Math.sin(ang) * d,
      seed: (p.seed + 977 * (i + 1)) >>> 0,
      at,
      propId: p.id,
    });
  }
  return out;
}

/**
 * How grown a rick is at `t`: -1 before there is anything to see, then 0 (a
 * heap of cut hay), 1 (a proper cock), 2 (a thatched rick with its pole).
 *
 * Pure in (t, at), with no memory of either direction of travel.
 */
export function hayStage(t: number, at: number): -1 | 0 | 1 | 2 {
  if (t < at) return -1;
  const d = t - at;
  return d < HAY_GROW ? 0 : d < HAY_GROW * 2 ? 1 : 2;
}

/* ========================== growing lumber piles ========================== */

/**
 * How far a timber yard's reach goes, in tiles. Ten is about a town and its
 * doorstep: the plots it is clearing and the first stretch of the lanes going
 * out of it, and not the next town's wood.
 */
export const PILE_REACH = 10;

/** Every tree the map has promised to somebody's axe — a plot's or a road's. */
export function doomedTrees(map: GenesisMap): Set<string> {
  const doomed = new Set<string>();
  for (const s of map.sites) {
    for (const b of s.buildings) for (const id of b.clears) doomed.add(id);
  }
  for (const r of map.roads) for (const c of r.clears ?? []) doomed.add(c.tree);
  return doomed;
}

/**
 * For every `lumber` prop in the valley, the trees within reach of it that are
 * ever going to come down.
 *
 * This is the whole of the pile's state, and it is MAP data — computed once,
 * never touched again. What makes the pile grow is not this list but how much
 * of it is in `snap.felled` at `t`, which is an existing snapshot field written
 * by an existing event. No new event type, no new snapshot state: a pile is a
 * COUNT of finished chops, and the day already records every one of them.
 */
export function pileReach(map: GenesisMap, doomed: Set<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const trees = map.trees.filter((t) => doomed.has(t.id));
  for (const s of map.sites) {
    for (const p of s.props) {
      if (p.kind !== 'lumber') continue;
      const near: string[] = [];
      for (const t of trees) {
        const dx = t.gx - p.gx;
        const dy = t.gy - p.gy;
        if (dx * dx + dy * dy <= PILE_REACH * PILE_REACH) near.push(t.id);
      }
      out.set(p.id, near);
    }
  }
  return out;
}

/**
 * How high the pile stands: 0 (a couple of boards), 1 (the stack that has
 * always been there), 2 (a yard doing well out of the day).
 *
 * Measured as the FRACTION of the reachable wood that is already down, not the
 * raw count, because the raw count is a fact about the forest rather than about
 * the day: a yard on the edge of the firs has eighty trees within reach and a
 * yard on the moor has nine, and both of them should look like they are filling
 * up at about the same rate as their own axes finish. The absolute floors under
 * stages 1 and 2 stop a yard with four trees near it jumping to a full stack on
 * the strength of one morning's work.
 *
 * The two thresholds are set HIGH (a half and six sevenths) on purpose. A
 * town's own plot clearing is front-loaded — you clear before you build — so
 * anything lower puts every yard at its full height by mid-morning and the
 * feature disappears. At these, a baseline day's founding yard stands at the
 * middle stage through the morning and only fills once the lanes out of town
 * have been cut too, which is the difference the whole thing exists to show.
 *
 * A yard with nothing in reach keeps the middle stage all day — that is the
 * sprite it had before any of this, and a pile that is never going to grow
 * should not spend the day looking like it has been robbed.
 */
export function pileStage(reach: string[], felled: Map<string, number>): 0 | 1 | 2 {
  const total = reach.length;
  if (!total) return 1;
  let hits = 0;
  for (const id of reach) if (felled.has(id)) hits++;
  const frac = hits / total;
  if (frac >= 0.85 && hits >= 4) return 2;
  if (frac >= 0.5 && hits >= 2) return 1;
  return 0;
}
