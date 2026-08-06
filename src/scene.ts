/**
 * Genesis — renderer and ambient life.
 *
 * The Vale bakes its whole countryside into one canvas and blits it. Genesis
 * cannot: the world it draws is a *snapshot* of a day that is still happening,
 * so roads grow, trees fall, plots turn into houses and towns appear out of
 * nothing while the camera sits still.
 *
 * So the split here is different:
 *
 *   baked once per map   ground tiles (biome tint + jitter) and the river —
 *                        the only two things that never change during a day.
 *   baked, patched       the standing wood: every tree still on its feet plus
 *                        the wild scatter, on a second transparent layer the
 *                        size of the terrain bake. A day fells a couple of
 *                        hundred trees out of two thousand, so this layer is
 *                        *patched* — the handful of sprite rectangles that
 *                        changed are cleared and their neighbourhood redrawn —
 *                        rather than rebuilt. Dynamic entities that walk in
 *                        front of it get the Vale's occlusion repair: the few
 *                        baked sprites standing in front of a mover are drawn
 *                        again, in the moving pass, at exactly the pixel the
 *                        bake put them.
 *   rebuilt every frame  roads clipped to their built fraction, bridges by
 *                        stage, and one depth-sorted sprite pass over the trees
 *                        that are *changing* (under the axe, or already stumps),
 *                        site dressing and buildings at their current progress.
 *
 * Over the top of the finished frame goes the sky: one multiply fill that takes
 * the valley from noon through gold, dusk, indigo and near-black, and back up
 * through a grey-blue pre-dawn. Lamps and lit windows get additive halos once
 * it is dark enough to want them.
 *
 * Sprites are still cached hard: scenery comes out of small pools, and each
 * building keeps one baked canvas keyed by `id:progress`, rebuilt only when the
 * timeline actually moves that building on.
 *
 * Everything is drawn at *world resolution* into an offscreen frame the size of
 * the visible world rectangle, which is then blitted to the viewport at the
 * camera's magnification with smoothing off. That is what keeps the isometric
 * edges hard at every zoom — `poly()` snaps spans to whole pixels, and it can
 * only do that if nobody has scaled the context under it.
 *
 * Sprite factories are imported wholesale from the Vale's `art.ts`; this module
 * deliberately does not import the Vale's `scene.ts`.
 */

import {
  PAL,
  buildBarrels,
  buildBonfire,
  buildBunting,
  buildBush,
  buildCampfire,
  buildCart,
  buildChest,
  buildChestMound,
  buildCrane,
  buildCrates,
  buildCropRow,
  buildFence,
  buildFlowerPatch,
  buildForestPattern,
  buildHaystack,
  buildLamp,
  buildLumber,
  buildMarketStall,
  buildNameBoard,
  buildQuarryBlocks,
  buildReeds,
  buildRock,
  /* ---- ruins (additive) ---- */
  buildRubble,
  buildRuinWall,
  /* ---- end ruins (additive) ---- */
  buildSheep,
  buildShed,
  buildSignpost,
  buildStake,
  buildStructure,
  buildStump,
  buildTree,
  buildWell,
  drawBonfire,
  drawBot,
  drawCart,
  drawChestGlint,
  drawCraneLoad,
  drawWheel,
  isoTile,
  mix,
  mulberry32,
  poly,
  rect,
  roofPeak,
  shade,
  type BotAction,
  type Ctx,
  type Pt,
  type Sprite,
  type StructureSprite,
} from '../vale/art';
import {
  PLAIN_DAY,
  auroraAt,
  eclipseAt,
  festivalFire,
  marketSite,
  marketStalls,
  mistAt,
  stormAt,
  workPace,
  type DayInfo,
  type Season,
  type StallSpec,
} from './daytype.ts';
import {
  TH,
  TW,
  isoX,
  isoY,
  type BuildingSpec,
  type ChestSpec,
  type ChestState,
  type GenesisMap,
  type LakeSpec,
  type PropSpec,
  type RoadSpec,
  /* ---- ruins (additive) ---- */
  type RuinSpec,
  /* ---- end ruins (additive) ---- */
  type SiteSpec,
  type TreeSpec,
  type Vec2,
  type WorldSnapshot,
} from './types';

/* ---------------------------- perf breakdown ----------------------------- */

/**
 * Where `?perf=2` puts its stopwatch readings.
 *
 * Milliseconds accumulate across a reporting window and are divided by
 * `frames` by whoever prints them; the three counters are sums too, so they
 * average the same way. Nothing here is allocated, touched or even branched on
 * unless a caller has installed a sink, which only `?perf=2` does — every
 * timing call below is behind `if (P)`, so an ordinary frame pays one null
 * check per phase and nothing else.
 */
export interface PerfPhases {
  /** Frame buffer resize, context reset, `skyAt`. */
  setup: number;
  /** `syncVeg` plus the standing-wood blit. */
  veg: number;
  /** Beyond-woodland pattern fill and the baked terrain blit. */
  bg: number;
  /** Roads, clipped to their built fraction, and bridges — repainted per frame. */
  roads: number;
  /** Building the dynamic item list: trees, chests, props, buildings, crowd. */
  build: number;
  /** Occlusion repair query. */
  occl: number;
  /** Depth sort and item draw. */
  draw: number;
  /** Hammer sparks and chimney smoke — particles, and evening's are thickest. */
  fx: number;
  /** World buffer → viewport. */
  blit: number;
  /** Sky multiply, horizon gradient, lamp halos, weather. */
  post: number;
  /** Wildlife: step, ground push, air draw, fireflies. */
  wild: number;
  frames: number;
  items: number;
  halos: number;
  repairs: number;
}

export function emptyPhases(): PerfPhases {
  return {
    setup: 0, veg: 0, bg: 0, roads: 0, build: 0, occl: 0, draw: 0, fx: 0,
    blit: 0, post: 0, wild: 0, frames: 0, items: 0, halos: 0, repairs: 0,
  };
}

let perfSink: PerfPhases | null = null;

/** Install (or, with `null`, remove) the `?perf=2` breakdown sink. */
export function setPerfSink(sink: PerfPhases | null): void {
  perfSink = sink;
}

/* ------------------------------ sprite pools ----------------------------- */

function pool<T>(n: number, make: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => make(i));
}

/** The scenery sprite pools, one entry per prop/tree kind. Exported so the
 * catalog page can enumerate every kind the simulation can draw.
 *
 * `season` repaints the deciduous pools once, at bake, on the finished pixels —
 * see `seasonCanvas`. Omitted, the pools are the summer art they have always
 * been, which is what the catalog draws. */
export function makePools(season: Season = 'summer'): Record<string, Sprite[]> {
  const pools: Record<string, Sprite[]> = {
    oak: pool(6, (i) => buildTree(0, 11 + i * 37)),
    pine: pool(6, (i) => buildTree(1, 23 + i * 41)),
    blossom: pool(4, (i) => buildTree(2, 31 + i * 43)),
    hedgerow: pool(4, (i) => buildTree(3, 47 + i * 29)),
    birch: pool(5, (i) => buildTree(4, 107 + i * 33)),
    willow: pool(4, (i) => buildTree(5, 113 + i * 27)),
    fir: pool(5, (i) => buildTree(6, 127 + i * 39)),
    bush: pool(6, (i) => buildBush(53 + i * 17)),
    rock: pool(6, (i) => buildRock(59 + i * 19)),
    flowers: pool(6, (i) => buildFlowerPatch(61 + i * 23)),
    reeds: pool(4, (i) => buildReeds(67 + i * 13)),
    stump: pool(5, (i) => buildStump(71 + i * 11)),
    crop: pool(4, (i) => buildCropRow(73 + i * 7)),
    haystack: pool(4, (i) => buildHaystack(79 + i * 5)),
    fenceL: pool(1, () => buildFence('l')),
    fenceR: pool(1, () => buildFence('r')),
    shed: pool(4, (i) => buildShed(83 + i * 31)),
    cart: pool(2, (i) => buildCart(i === 0)),
    crates: pool(3, (i) => buildCrates(89 + i * 13)),
    lumber: pool(3, (i) => buildLumber(97 + i * 17)),
    barrels: pool(3, (i) => buildBarrels(101 + i * 19)),
    well: pool(1, () => buildWell()),
    lamp: pool(1, () => buildLamp()),
    sheep: pool(3, (i) => buildSheep(103 + i * 23)),
    campfire: pool(1, () => buildCampfire()),
    // Buried treasure, in its three states. Never a PropSpec — chests are their
    // own list on the map, so nothing resolves these by kind; they are pooled
    // for the cache and so the catalog page can show them.
    'chest-buried': pool(3, (i) => buildChestMound(211 + i * 13)),
    'chest-closed': pool(2, (i) => buildChest(false, 223 + i * 17)),
    'chest-open': pool(2, (i) => buildChest(true, 227 + i * 19)),
    'quarry-blocks': pool(3, (i) => buildQuarryBlocks(139 + i * 21)),
  };
  if (season !== 'summer') {
    for (const k of DECIDUOUS) for (const sp of pools[k]) seasonCanvas(sp.c, season);
  }
  return pools;
}

/** Which of the three chest sprites the snapshot is asking for. */
function chestSprite(scene: GenesisScene, chest: ChestSpec, state: ChestState | undefined): Sprite {
  const p =
    state === 'open'
      ? scene.pools['chest-open']
      : state === 'digging'
        ? scene.pools['chest-closed']
        : scene.pools['chest-buried'];
  return p[Math.abs(chest.seed) % p.length];
}

const TREE_POOL: Record<string, string> = {
  oak: 'oak',
  pine: 'pine',
  blossom: 'blossom',
  hedgerow: 'hedgerow',
  birch: 'birch',
  willow: 'willow',
  fir: 'fir',
};

/* --------------------------------- types --------------------------------- */

export interface Smoke {
  x: number;
  y: number;
  age: number;
  drift: number;
}

/** A settler still on the road in, before they join the site's crew. */
export interface Arrival {
  roadId: string;
  /** Arclength along the road, walked towards the end nearest the site. */
  s: number;
  dir: 1 | -1;
}

export interface Bot {
  site: string;
  slot: number;
  gx: number;
  gy: number;
  tx: number;
  ty: number;
  action: BotAction;
  timer: number;
  phase: number;
  color: string;
  faceRight: boolean;
  jx: number;
  jy: number;
  /** Carriers shuttle: 0 = heading to the plot, 1 = heading back to the yard. */
  leg: 0 | 1;
  /** Set while the settler is still walking in; null once they are local. */
  arrive: Arrival | null;
}

export interface Walker {
  roadId: string;
  s: number;
  dir: 1 | -1;
  phase: number;
  color: string;
  gx: number;
  gy: number;
  faceRight: boolean;
  /** Highways carry freight: this walker is pulling a hand cart. */
  cart: boolean;
  /** Colour of the load on the bed. Unused when `cart` is false. */
  cargo: string;
}

/**
 * The one settler who walks out to a chest, turns the earth over it and gets
 * the lid up. They are not part of any site's crew — the chest is usually a
 * long way out in the wood — so they live in their own list and are staffed
 * straight off the snapshot's chest state.
 */
export interface Digger {
  chestId: string;
  gx: number;
  gy: number;
  tx: number;
  ty: number;
  /** Where they walked out from, and where they trudge back to. */
  hx: number;
  hy: number;
  phase: number;
  color: string;
  faceRight: boolean;
  action: BotAction;
  /** 0 = out at the chest, 1 = walking home with the news. */
  leg: 0 | 1;
}

/** One pixel of the moment the lid comes up. */
export interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  color: string;
}

export interface Ambient {
  bots: Bot[];
  /**
   * `bots` grouped by site id, rebuilt only when the crowd actually changes.
   * The step loop runs once per site per frame and used to re-filter the whole
   * population to find each crew, which is quadratic in a valley of eight
   * towns; this is the same list, kept.
   */
  crews: Map<string, Bot[]>;
  /** Settlers per site at the last sync, so an *increase* can be walked in. */
  pop: Map<string, number>;
  walkers: Walker[];
  /** One per chest currently being dug out or just opened. */
  diggers: Digger[];
  /** The pixels thrown up at the moment a lid comes off. */
  sparks: Spark[];
  /** Chests we have already thrown sparks for, so the moment happens once. */
  opened: Set<string>;
  smoke: Smoke[];
  smokeClock: { t: number };
  smokers: { x: number; y: number }[];
  wheels: { x: number; y: number }[];
  /** Cheap fingerprint of everything the ambient layer derives from. */
  sig: string;
  rng: () => number;
  /**
   * Work pace, matching the pace the timeline was built at. It never changes
   * *what* the ambient layer does, only how hard it looks: legs and hammers run
   * at sqrt(pace), and a busy valley puts an extra hand or two on each site.
   */
  pace: number;
}

interface RoadGeo {
  cum: number[];
  len: number;
}

/**
 * Paint order at exactly equal depth, which is the order the per-frame pass
 * used to draw these things in: the whole standing wood goes down first, then
 * stumps, then site dressing. Only ever consulted when two sprites share a
 * depth to the last bit; it exists so that baking cannot silently reorder a
 * pair the old pass had an opinion about.
 */
const R_WOOD = 0;
const R_STUMP = 1;
const R_PROP = 2;
/* ---- ruins (additive) ---- */
/** Appended, never renumbered: a ruin is the last thing painted at equal depth
 * because it is the only static that is bigger than everything around it. */
const R_RUIN = 3;
/* ---- end ruins (additive) ---- */

/** One sprite that lives on the scenery layer. */
interface VegItem {
  sprite: Sprite;
  depth: number;
  bx: number;
  by: number;
  bw: number;
  bh: number;
  /** `R_WOOD` | `R_STUMP` | `R_PROP` — the tie-break above. */
  rank: number;
  /** Tie-break inside a rank: the order the old per-frame pass pushed them. */
  ord: number;
  /** Set for standing trees; undefined for everything else. */
  treeId?: string;
}

export interface VegLayer {
  c: HTMLCanvasElement;
  ctx: Ctx;
  items: VegItem[];
  /** Item indexes by 96px cell, for occlusion repair and for patching. */
  grid: Map<number, number[]>;
  /** Parallel to `items`: is this sprite currently painted on the layer? */
  on: boolean[];
  /** `snap.trees.size` the layer was last reconciled against; -1 = never. */
  size: number;
  /**
   * Two item slots per map tree — the tree standing, and the stump it leaves —
   * of which at most one is ever painted. `2*k` and `2*k+1`.
   */
  slots: Int32Array;
  /**
   * Trees currently mid-chop, as indexes into `map.trees`. A tree only ever
   * goes standing -> felling -> stump, and the first of those two steps grows
   * `snap.trees`; so when the entry count has not moved, the only states that
   * *can* have changed are these, and reconciling costs a handful of lookups
   * instead of two thousand. This is also exactly the list the per-frame pass
   * has to draw, because a tree under the axe is the one that shivers.
   */
  felling: number[];
  /** Item slot per site prop, in site/prop order; -1 if the kind has no art. */
  props: Int32Array;
  /** `snap.props.size` at the last reconcile; -1 = never. */
  propSize: number;
  /* MARKET — item slots for the stalls, empty except on a market day. They are
   * allocated with everything else at bake time (item index has to stay
   * synonymous with depth order for the life of the layer) and left unpainted
   * until nine in the morning. */
  stalls: number[];
  /** Are the stalls currently painted into the layer? */
  stallOn: boolean;
}

/**
 * The finished road network, painted once.
 *
 * Every road is a five-strip stroke plus a scatter of loose stones, and at
 * pace 4 a valley has seventeen of them — which is two and a half milliseconds
 * a frame to redraw something that has not changed since lunchtime. So a road
 * that has reached the end of its arclength is painted into this layer, once,
 * and drops out of the per-frame list.
 *
 * ORDER. Roads overlap where they meet, so *which* road is on top at a junction
 * is decided by paint order, and the per-frame pass paints them in map order.
 * The layer is blitted before the remaining per-frame roads, so a road may only
 * join the bake once every earlier road it overlaps has joined it too — which
 * is the whole of `deps`. In practice roads are also *finished* in map order,
 * so nothing is ever held back; the rule is there so that nothing can be.
 */
interface RoadLayer {
  c: HTMLCanvasElement;
  ctx: Ctx;
  /** Where the layer's top-left sits in world pixels — its own, tighter than
   * the terrain bake's, because a road network never reaches the padding. */
  x: number;
  y: number;
  /** Parallel to `map.roads`: painted into `c`? */
  baked: boolean[];
  /** Earlier road indexes whose painted band touches this one's. */
  deps: number[][];
  /** How many are baked — a nonzero count is the only reason to blit. */
  n: number;
}

/** The cell size of the vegetation index, in world pixels. */
const VCELL = 96;
/**
 * How many baked sprites one frame may redraw to repair occlusion. A whole
 * valley of towns at dusk can ask for more than it can see the benefit of; past
 * this the frame simply stops, having already served every mover.
 */
const REPAIR_CAP = 260;
const vkey = (cx: number, cy: number) => cx * 4096 + cy;

export interface GenesisScene {
  map: GenesisMap;
  /** Baked terrain + river, and where its top-left sits in world pixels. */
  layer: HTMLCanvasElement;
  lx: number;
  ly: number;
  /** Standing trees + wild scatter, same size and origin as `layer`. */
  veg: VegLayer;
  /** Finished roads, same size and origin as `layer`, blitted between them. */
  roads: RoadLayer;
  surround: HTMLCanvasElement;
  frame: HTMLCanvasElement;
  pools: Record<string, Sprite[]>;
  extra: Map<string, Sprite>;
  structs: Map<string, { key: string; sp: StructureSprite }>;
  roadGeo: Map<string, RoadGeo>;
  roadById: Map<string, RoadSpec>;
  treeById: Map<string, TreeSpec>;
  siteProps: Map<string, { p: PropSpec; accent: string }>;
  /** World-pixel extent of the map itself (not the padded layer). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Soft warm halo, baked on first nightfall. */
  glow: HTMLCanvasElement | null;
  /** Are windows lit? Flipped by the sky curve; part of the structure cache key. */
  lit: boolean;
  /** How many structures may be re-baked for a lit/unlit flip this frame. */
  relight: number;
  /**
   * What kind of day this is and what time of year, decided by the caller that
   * knows where the seed came from. Constant for the life of the bake, which is
   * exactly one day — so the season is baked into the ground and the leaves,
   * and only the weather is a per-frame overlay.
   */
  day: DayInfo;
  /** Flat colour under the woodland pattern, seasoned to match it. */
  beyond: string;
  /* ---- ruins (additive) ------------------------------------------------- */
  /**
   * Yesterday's ghost, or null. Not part of the map — see ghost.ts — so it is
   * handed to the bake by the one caller that knows which seed came before, and
   * it is baked with the other statics because, like every ruin, it is the same
   * at one minute past midnight as it is at ten to.
   */
  ghost: RuinSpec | null;
  /* ---- end ruins (additive) --------------------------------------------- */
  /* MARKET+FESTIVAL ---------------------------------------------------- */
  /** Market pitches, on a market day. Empty on every other kind of day. */
  stalls: StallSpec[];
  /** The town the market came to. Null unless this is a market day. */
  market: SiteSpec | null;
  /** Where the festival fire would be built, if the valley earns one. */
  fire: Vec2 | null;
  /**
   * The hour the festival starts, or 0 on a day that did not earn one.
   *
   * The bake cannot answer this — it is a fact about the *timeline*, and the
   * scene has never seen one — so the caller that built both sets it from
   * `festivalAt(map, timeline)`. Left at 0, every festival path below is one
   * comparison that fails, which is what a headless harness with no timeline
   * should see.
   */
  fest: number;
}

export interface GView {
  /** World pixel at the top-left of the viewport. */
  cx: number;
  cy: number;
  /** CSS pixels per world pixel. */
  zoom: number;
  vw: number;
  vh: number;
  /**
   * Device pixels per CSS pixel — the canvas backing store is `vw*dpr` wide.
   * `zoom * dpr` is therefore the real magnification the panel sees, and it is
   * that product the zoom ladder keeps whole. Absent means 1.
   */
  dpr?: number;
}

/* -------------------------------- geometry ------------------------------- */

function cumulative(pts: Vec2[]): RoadGeo {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return { cum, len: cum[cum.length - 1] || 1 };
}

/** The first `frac` of a polyline's arclength, with a partial final segment. */
function cutPolyline(pts: Vec2[], geo: RoadGeo, frac: number): Vec2[] {
  if (frac <= 0 || pts.length < 2) return [];
  if (frac >= 1) return pts;
  const want = geo.len * frac;
  const out: Vec2[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (geo.cum[i] <= want) {
      out.push(pts[i]);
      continue;
    }
    const seg = geo.cum[i] - geo.cum[i - 1] || 1;
    const f = (want - geo.cum[i - 1]) / seg;
    out.push([
      pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
      pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f,
    ]);
    break;
  }
  return out.length >= 2 ? out : [];
}

function alongPolyline(pts: Vec2[], geo: RoadGeo, s: number): Vec2 {
  const d = Math.max(0, Math.min(geo.len, s));
  let i = 1;
  while (i < geo.cum.length - 1 && geo.cum[i] < d) i++;
  const seg = geo.cum[i] - geo.cum[i - 1] || 1;
  const f = (d - geo.cum[i - 1]) / seg;
  return [
    pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
    pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f,
  ];
}

/** Prolong the first and last segments of a polyline by `by` tiles. */
function extendEnds(pts: Vec2[], by: number): Vec2[] {
  if (pts.length < 2) return pts;
  const ext = (from: Vec2, to: Vec2): Vec2 => {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const d = Math.hypot(dx, dy) || 1;
    return [to[0] + (dx / d) * by, to[1] + (dy / d) * by];
  };
  return [ext(pts[1], pts[0]), ...pts, ext(pts[pts.length - 2], pts[pts.length - 1])];
}

function segDist(px: number, py: number, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  let t = ((px - a[0]) * dx + (py - a[1]) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (a[0] + dx * t), py - (a[1] + dy * t));
}

/** Quad strip along a tile-space polyline, in world pixels. */
export function strip(ctx: Ctx, pts: Vec2[], halfW: number, color: string): void {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const tx = bx - ax;
    const ty = by - ay;
    const len = Math.hypot(tx, ty) || 1;
    const nx = (-ty / len) * halfW;
    const ny = (tx / len) * halfW;
    // Overshoot the joints a hair so consecutive quads never leave a notch.
    const ex = (tx / len) * 0.12;
    const ey = (ty / len) * 0.12;
    const q: Pt[] = [
      [isoX(ax + nx - ex, ay + ny - ey), isoY(ax + nx - ex, ay + ny - ey)],
      [isoX(bx + nx + ex, by + ny + ey), isoY(bx + nx + ex, by + ny + ey)],
      [isoX(bx - nx + ex, by - ny + ey), isoY(bx - nx + ex, by - ny + ey)],
      [isoX(ax - nx - ex, ay - ny - ey), isoY(ax - nx - ex, ay - ny - ey)],
    ];
    poly(ctx, q, color);
  }
}

/**
 * A lake's outline scaled about its own centre.
 *
 * `lk.pts` is the shore at k = 1, and the generator builds it as centre plus a
 * radial offset — so scaling those offsets is exactly the same curve the
 * generator would have produced at that radius, which is what lets the whole
 * five-strip bake below come out of one stored polygon.
 */
export function lakeRing(lk: LakeSpec, k: number): Vec2[] {
  return lk.pts.map(([gx, gy]) => [lk.gx + (gx - lk.gx) * k, lk.gy + (gy - lk.gy) * k] as Vec2);
}

/** Fill a closed tile-space polygon. The lake counterpart of `strip`. */
export function waterBlob(ctx: Ctx, pts: Vec2[], color: string): void {
  poly(
    ctx,
    pts.map(([gx, gy]) => [isoX(gx, gy), isoY(gx, gy)] as Pt),
    color
  );
}

/**
 * One lake, laid down in the six-strip family the ground bake uses: sand, dark
 * sand, shallow, water, deep, and a darker heart — because a pond with a light
 * middle reads as a puddle. Then foam where the water meets the sand and a
 * couple of flat glints out on the surface, both seeded off the lake so they
 * never crawl.
 *
 * Lifted out of `buildGenesisScene` verbatim so the catalog page can bake a
 * lake of its own with exactly the renderer's own strips.
 */
export function bakeLake(ctx: Ctx, lk: LakeSpec): void {
  const ring = (k: number) => lakeRing(lk, k);
  waterBlob(ctx, ring(1.15), PAL.sand);
  waterBlob(ctx, ring(1.07), shade(PAL.sand, -0.12));
  waterBlob(ctx, ring(1.0), PAL.waterLight);
  waterBlob(ctx, ring(0.93), PAL.water);
  waterBlob(ctx, ring(0.76), PAL.waterDeep);
  waterBlob(ctx, ring(0.44), shade(PAL.waterDeep, -0.16));
  const lrng = mulberry32((lk.seed ^ 0x606f0a11) >>> 0);
  const shore = ring(1.0);
  for (let i = 0; i < shore.length; i++) {
    const a = shore[i];
    const b = shore[(i + 1) % shore.length];
    const t = lrng();
    const gx = a[0] + (b[0] - a[0]) * t;
    const gy = a[1] + (b[1] - a[1]) * t;
    rect(ctx, isoX(gx, gy) - 2, isoY(gx, gy), 3 + lrng() * 4, 1, PAL.waterFoam);
  }
  const glint = ring(0.6);
  for (let i = 0; i < glint.length; i += 5) {
    const [gx, gy] = glint[i];
    rect(ctx, isoX(gx, gy) - 3, isoY(gx, gy), 4 + lrng() * 5, 1, shade(PAL.waterLight, 0.18));
  }
}

/**
 * The ground under an outcrop: bare rock showing through the biome tint, by
 * `rocky` (0 at the edge of the influence, 1 at the heart of it). Exported so
 * the catalog can show the tint on its own.
 */
export function outcropTint(col: string, rocky: number): string {
  return mix(col, PAL.stoneDark, rocky * 0.62);
}

/**
 * One road, painted along a tile-space polyline: verge, edge, carriageway, a
 * paler centre for a highway, then loose stones seeded from `stoneSeed` so the
 * ruts do not crawl frame to frame. Exported so the catalog can draw a sample
 * of each road kind with exactly the renderer's own strips.
 */
export function paintRoad(
  ctx: Ctx,
  pts: Vec2[],
  kind: RoadSpec['kind'],
  width: number,
  stoneSeed: number
): void {
  strip(ctx, pts, width + 0.55, mix(PAL.grassEdge, PAL.dirt, 0.55));
  strip(ctx, pts, width + 0.16, PAL.dirtEdge);
  strip(ctx, pts, width, PAL.dirt);
  strip(ctx, pts, width * 0.42, kind === 'highway' ? PAL.dirtPale : PAL.dirtAlt);
  const rr = mulberry32(stoneSeed);
  for (let i = 0; i + 1 < pts.length; i++) {
    const steps = Math.max(
      2,
      Math.round(Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) * 1.2)
    );
    for (let k = 0; k < steps; k++) {
      const t = (k + rr()) / steps;
      const gx = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
      const gy = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
      const off = (rr() - 0.5) * width * 1.6;
      rect(ctx, isoX(gx, gy) + off * 16, isoY(gx, gy) + off * 6, 2 + rr() * 3, 1, PAL.dirtEdge);
    }
  }
}

/* ------------------------------ finished roads ---------------------------- */

/** Closest approach of two segments, 0 if they cross. Tile units. */
function segSegDist(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): number {
  const d1x = a2[0] - a1[0];
  const d1y = a2[1] - a1[1];
  const d2x = b2[0] - b1[0];
  const d2y = b2[1] - b1[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) > 1e-9) {
    const ex = b1[0] - a1[0];
    const ey = b1[1] - a1[1];
    const s = (ex * d2y - ey * d2x) / den;
    const u = (ex * d1y - ey * d1x) / den;
    if (s >= 0 && s <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(
    segDist(a1[0], a1[1], b1, b2),
    segDist(a2[0], a2[1], b1, b2),
    segDist(b1[0], b1[1], a1, a2),
    segDist(b2[0], b2[1], a1, a2)
  );
}

/**
 * How far off its centreline a road can put ink, in tile units: the widest
 * strip is `width + 0.55`, and the loose stones are thrown a further
 * `width * 0.8` sideways and are a few screen pixels long. Deliberately
 * generous — an overestimate only costs a road its place in the bake for as
 * long as an earlier neighbour is unfinished, and they finish in order anyway.
 */
const roadReach = (r: RoadSpec) => r.width * 1.8 + 1.5;

/**
 * The widest a road's ink can stray from a control point, in world pixels.
 * `strip` offsets by `halfW` tile units perpendicular and projects, which is
 * 16 px of x and 8 px of y per tile unit; the stones add another `width * 0.8`
 * sideways and a few pixels of their own length. Rounded well up.
 */
const ROAD_MARGIN = 64;

function buildRoadLayer(scene: GenesisScene): RoadLayer {
  const roads = scene.map.roads;
  // A road network reaches from town to town and never into the padding the
  // terrain bake carries, so the layer only has to be as big as the network.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of roads) {
    for (const [gx, gy] of r.pts) {
      const x = isoX(gx, gy);
      const y = isoY(gx, gy);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const empty = !roads.length;
  const rx = empty ? 0 : Math.floor(x0) - ROAD_MARGIN;
  const ry = empty ? 0 : Math.floor(y0) - ROAD_MARGIN;
  const c = document.createElement('canvas');
  c.width = empty ? 1 : Math.ceil(x1) + ROAD_MARGIN - rx;
  c.height = empty ? 1 : Math.ceil(y1) + ROAD_MARGIN - ry;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.translate(-rx, -ry);

  const deps: number[][] = roads.map(() => []);
  for (let i = 0; i < roads.length; i++) {
    const ri = roads[i];
    for (let j = 0; j < i; j++) {
      const rj = roads[j];
      const reach = roadReach(ri) + roadReach(rj);
      let hit = false;
      for (let a = 0; a + 1 < ri.pts.length && !hit; a++) {
        for (let b = 0; b + 1 < rj.pts.length; b++) {
          if (segSegDist(ri.pts[a], ri.pts[a + 1], rj.pts[b], rj.pts[b + 1]) < reach) {
            hit = true;
            break;
          }
        }
      }
      if (hit) deps[i].push(j);
    }
  }
  return { c, ctx, x: rx, y: ry, baked: roads.map(() => false), deps, n: 0 };
}

/** The stone seed a road is stroked with — same expression in both passes. */
const roadStoneSeed = (road: RoadSpec) => 2024 + road.id.length * 31;

/**
 * Move every newly finished road onto the layer, and throw the layer away if a
 * scrub has un-built one. Ascending order, so a road whose dependencies clear
 * in this very pass still joins in this very pass.
 */
function syncRoads(scene: GenesisScene, snap: WorldSnapshot): void {
  const R = scene.roads;
  const roads = scene.map.roads;
  if (R.n) {
    for (let i = 0; i < roads.length; i++) {
      if (R.baked[i] && (snap.roads.get(roads[i].id) ?? 0) < 1) {
        R.ctx.save();
        R.ctx.setTransform(1, 0, 0, 1, 0, 0);
        R.ctx.clearRect(0, 0, R.c.width, R.c.height);
        R.ctx.restore();
        R.baked.fill(false);
        R.n = 0;
        break;
      }
    }
  }
  if (R.n === roads.length) return;
  for (let i = 0; i < roads.length; i++) {
    if (R.baked[i]) continue;
    if ((snap.roads.get(roads[i].id) ?? 0) < 1) continue;
    let ready = true;
    for (const j of R.deps[i]) if (!R.baked[j]) ready = false;
    if (!ready) continue;
    const road = roads[i];
    paintRoad(R.ctx, road.pts, road.kind, road.width, roadStoneSeed(road));
    R.baked[i] = true;
    R.n++;
  }
}

/* ---------------------------------- bake --------------------------------- */

/**
 * Build the whole scene in one go. Every caller that can afford ~150ms — the
 * first load, a new seed, a new pace — uses this.
 *
 * @param day What kind of day, and what time of year. The season reaches the
 *   ground tint and the leaf pools from here and nowhere else; the day type is
 *   kept on the scene for the overlays and the sky. Defaults to an ordinary
 *   summer day, which is the world exactly as it was before rare days existed.
 * @param ghost Yesterday's ruin, from `ghostFor(map, prevSeed)` — additive, and
 *   null for every caller that does not know (or care) what came before.
 */
export function buildGenesisScene(
  map: GenesisMap,
  day: DayInfo = PLAIN_DAY,
  ghost: RuinSpec | null = null
): GenesisScene {
  const steps = buildGenesisSceneSteps(map, day, ghost);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * The same build, as a generator that pauses at safe points.
 *
 * The one caller that cannot afford 150ms in a single tick is the pre-generator
 * that runs while the visitor is watching the valley go dark before midnight:
 * a hitch there is a hitch in the one moment the day is supposed to hand over
 * invisibly. So it drives this a step at a time, one step per frame, and the
 * whole build is spread over a couple of seconds of a world that has nothing
 * left to do.
 *
 * It is a generator and not a hand-rolled state machine on purpose: there is
 * exactly one copy of the build, so the stepped path cannot drift from the
 * synchronous one. The `yield`s are placed where no local is half-written and
 * — crucially — where no seeded rng stream is mid-sequence, which a generator
 * preserves for free.
 */
export function* buildGenesisSceneSteps(
  map: GenesisMap,
  day: DayInfo = PLAIN_DAY,
  ghost: RuinSpec | null = null
): Generator<void, GenesisScene, void> {
  const B = map.bounds;
  const x0 = B.u0 * (TW / 2);
  const x1 = B.u1 * (TW / 2);
  const y0 = B.v0 * (TH / 2);
  const y1 = B.v1 * (TH / 2);
  // Tiles are laid a few rows past the declared bounds so the sawtooth edge of
  // the diamond grid falls outside the `content` rect the camera frames.
  const OVER_U = 14;
  const OVER_V = 28;
  const PAD = 24 + Math.max(OVER_U * (TW / 2), OVER_V * (TH / 2));

  const W = Math.ceil(x1 - x0) + PAD * 2;
  const H = Math.ceil(y1 - y0) + PAD * 2;

  const layer = document.createElement('canvas');
  layer.width = W;
  layer.height = H;
  const ctx = layer.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const lx = Math.round(x0 - PAD);
  const ly = Math.round(y0 - PAD);
  ctx.translate(-lx, -ly);

  /* ---- biome tint: inverse-distance blend of the chunk centres --------- */
  const centres = map.chunks.map((c) => ({
    u: (c.u0 + c.u1) / 2,
    v: (c.v0 + c.v1) / 2,
    rgb: hexRGB(PAL.biome[c.biome] ?? PAL.biome.meadow),
  }));
  const tintAt = (u: number, v: number): [number, number, number] => {
    let wr = 0;
    let wg = 0;
    let wb = 0;
    let ws = 0;
    for (const c of centres) {
      const du = (u - c.u) * 0.5;
      const dv = v - c.v;
      const d2 = du * du + dv * dv + 4;
      const w = 1 / (d2 * d2);
      wr += c.rgb[0] * w;
      wg += c.rgb[1] * w;
      wb += c.rgb[2] * w;
      ws += w;
    }
    return ws > 0 ? [wr / ws, wg / ws, wb / ws] : [142, 208, 159];
  };

  /* ---- bare stone showing through under every outcrop ------------------ */
  // The boulders themselves are ordinary `rock` scatter; this is the ground
  // they stand on, so an outcrop reads as a patch of exposed rock rather than
  // as a suspiciously tidy pile of stones on a lawn.
  const outcrops = map.outcrops ?? [];
  const rockAt = (gx: number, gy: number): number => {
    let best = 0;
    for (const o of outcrops) {
      const du = gx - gy - (o.gx - o.gy);
      const dv = gx + gy - (o.gx + o.gy);
      const d = Math.hypot(du, dv) / Math.max(1.5, o.radius);
      if (d < 1.2) best = Math.max(best, Math.min(1, (1.2 - d) / 0.5));
    }
    return best;
  };

  /* ---- a soft glade under every planned site --------------------------- */
  const gladeAt = (gx: number, gy: number): number => {
    let best = 0;
    for (const s of map.sites) {
      const du = gx - gy - (s.gx - s.gy);
      const dv = gx + gy - (s.gx + s.gy);
      const d = Math.hypot(du * 0.55, dv * 0.5) / Math.max(2, s.radius);
      if (d < 1.05) best = Math.max(best, Math.min(1, (1.05 - d) / 0.5));
    }
    return best;
  };

  const grng = mulberry32(1337);
  const grassEdge = seasonGround(PAL.grassEdge, day.season);
  const tuft = seasonGround(PAL.leafDark, day.season);
  yield;
  // The tile loop is by far the longest stretch of the build, so it breathes
  // every few rows. `grng` is a live sequence across the whole loop and the
  // generator keeps it exactly where it was — which is the reason a step is a
  // `yield` and not a re-entrant function.
  const V0 = Math.floor(B.v0) - OVER_V;
  const V1 = Math.ceil(B.v1) + OVER_V;
  const ROWS = 24;
  for (let v = V0; v <= V1; v++) {
    if (v > V0 && (v - V0) % ROWS === 0) yield;
    for (let u = Math.floor(B.u0) - OVER_U; u <= Math.ceil(B.u1) + OVER_U; u++) {
      if ((u + v) & 1) continue;
      const gx = (u + v) / 2;
      const gy = (v - u) / 2;
      const sx = u * (TW / 2);
      const sy = v * (TH / 2);

      const n =
        Math.sin(gx * 0.29 + gy * 0.17) * 0.5 +
        Math.sin(gx * 0.11 - gy * 0.31) * 0.3 +
        Math.sin((gx + gy) * 0.21 + 1.7) * 0.2;
      const h = (Math.imul(u | 0, 374761393) ^ Math.imul(v | 0, 668265263)) >>> 0;
      const jitter = [0.0, -0.035, 0.04, -0.015][h % 4];
      let col = shade(seasonGround(rgbHex(tintAt(u, v)), day.season), jitter + n * 0.05);

      const glade = gladeAt(gx, gy);
      if (glade > 0) col = mix(col, PAL.dirtPale, glade * 0.3);
      const rocky = rockAt(gx, gy);
      if (rocky > 0) col = outcropTint(col, rocky);

      isoTile(ctx, sx, sy, col);

      const r = grng();
      if (rocky > 0.5 && r < 0.16) {
        rect(ctx, sx - 3, sy, 4, 1, shade(PAL.stone, -0.14));
      } else if (glade < 0.4 && r < 0.09) {
        // Seasonal grass-edge tufts (day-types branch) on non-rocky ground.
        rect(ctx, sx - 4, sy + 1, 2, 1, grassEdge);
        rect(ctx, sx + 2, sy - 2, 2, 1, grassEdge);
      } else if (glade < 0.4 && r < 0.12) {
        rect(ctx, sx, sy - 1, 1, 2, tuft);
        rect(ctx, sx, sy - 3, 1, 1, PAL.flower[h % PAL.flower.length]);
      } else if (glade > 0.5 && r < 0.06) {
        rect(ctx, sx - 2, sy, 3, 1, PAL.dirtEdge);
      }
    }
  }

  yield;
  /* ---- the lakes ------------------------------------------------------- */
  // Drawn BEFORE the river, so a river-fed lake reads as the water widening
  // out rather than as a pond laid on top of a channel that vanishes into it.
  for (const lk of map.lakes ?? []) bakeLake(ctx, lk);
  yield;

  /* ---- the river ------------------------------------------------------- */
  // Run both ends on past the map edge so the water leaves the frame instead of
  // stopping dead in the middle of the padding.
  const river = extendEnds(map.river, OVER_V);
  const rw = map.riverWidth;
  strip(ctx, river, rw + 0.75, PAL.sand);
  strip(ctx, river, rw + 0.34, shade(PAL.sand, -0.12));
  strip(ctx, river, rw, PAL.waterDeep);
  strip(ctx, river, rw * 0.76, PAL.water);
  strip(ctx, river, rw * 0.34, PAL.waterLight);
  const wrng = mulberry32(808);
  for (let i = 0; i + 1 < river.length; i++) {
    for (let k = 0; k < 9; k++) {
      const t = (k + wrng()) / 9;
      const gx = river[i][0] + (river[i + 1][0] - river[i][0]) * t;
      const gy = river[i][1] + (river[i + 1][1] - river[i][1]) * t;
      const off = (wrng() - 0.5) * rw * 1.1;
      rect(ctx, isoX(gx, gy) + off * 16, isoY(gx, gy) + off * 6, 3 + wrng() * 4, 1, PAL.waterFoam);
    }
  }

  yield;
  /* ---- indexes --------------------------------------------------------- */
  const roadGeo = new Map<string, RoadGeo>();
  const roadById = new Map<string, RoadSpec>();
  for (const r of map.roads) {
    roadGeo.set(r.id, cumulative(r.pts));
    roadById.set(r.id, r);
  }
  const treeById = new Map<string, TreeSpec>();
  for (const t of map.trees) treeById.set(t.id, t);
  const siteProps = new Map<string, { p: PropSpec; accent: string }>();
  for (const s of map.sites) for (const p of s.props) siteProps.set(p.id, { p, accent: s.accent });

  // The endless woodland beyond the map is mostly conifer, so it only half
  // turns — but it has to turn, or the map sits in a summer frame all winter.
  const surround = buildForestPattern();
  seasonCanvas(surround, day.season, 0.6);
  yield;
  const pools = makePools(day.season);
  yield;

  const scene: GenesisScene = {
    map,
    layer,
    lx,
    ly,
    veg: null as unknown as VegLayer,
    roads: null as unknown as RoadLayer,
    surround,
    frame: document.createElement('canvas'),
    pools,
    extra: new Map(),
    structs: new Map(),
    roadGeo,
    roadById,
    treeById,
    siteProps,
    x0,
    y0,
    x1,
    y1,
    glow: null,
    lit: false,
    relight: 0,
    day,
    beyond: seasonGround('#3f7f66', day.season),
    /* ---- ruins (additive) ---- */
    ghost,
    /* ---- end ruins (additive) ---- */
    // MARKET+FESTIVAL — both are pure functions of the map. The stalls are only
    // ever asked for on the day that has them; the fire is cheap and the scene
    // does not yet know whether the valley is going to earn it.
    stalls: day.type === 'market' ? marketStalls(map) : [],
    market: day.type === 'market' ? marketSite(map) : null,
    fire: festivalFire(map),
    fest: 0,
  };
  scene.veg = yield* buildVeg(scene, W, H);
  yield;
  scene.roads = buildRoadLayer(scene);
  return scene;
}

/* ------------------------------- the scenery ----------------------------- */

/**
 * Every sprite that stands still.
 *
 * Originally this was the standing wood alone; everything else went through a
 * depth-sorted pass rebuilt from scratch every frame. But by evening at pace 4
 * that pass is fourteen hundred `drawImage` calls, and eleven hundred of them
 * are stumps, well-heads and haystacks that have not moved since the hour they
 * appeared. So the layer now carries all of them:
 *
 *   every tree, drawn standing         on while it stands
 *   the stump it leaves                on once the axe is done
 *   every wild scatter prop            always on
 *   every piece of site dressing       on once the timeline raises it
 *
 * All four go into ONE depth-sorted list on ONE canvas, because depth order
 * between them matters — a well in front of a fir has to be in front of it —
 * and a single sorted array is the only cheap way to say that. Slots for
 * things that do not exist yet are allocated and indexed at build time and
 * simply left unpainted, which is what keeps item index synonymous with depth
 * order for the whole life of the layer: the occlusion repair's early break and
 * `patchVeg`'s paint order both depend on that and on nothing else.
 *
 * What is left in the per-frame pass is what actually changes per frame: the
 * crowd, the wildlife, a tree mid-fall, a chest being dug, a building still
 * going up and its crane.
 */
function* buildVeg(
  scene: GenesisScene,
  W: number,
  H: number
): Generator<void, VegLayer, void> {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.translate(-scene.lx, -scene.ly);

  const items: VegItem[] = [];
  /** Build order, which the sort keeps as the tie-break inside a rank. */
  const add = (
    sprite: Sprite,
    gx: number,
    gy: number,
    rank: number,
    ord: number,
    treeId?: string
  ): number => {
    const x = isoX(gx, gy);
    const y = isoY(gx, gy);
    items.push({
      sprite,
      depth: y,
      bx: x - sprite.ox,
      by: y - sprite.oy,
      bw: sprite.c.width,
      bh: sprite.c.height,
      rank,
      ord,
      treeId,
    });
    return items.length - 1;
  };

  const trees = scene.map.trees;
  const slots = new Int32Array(trees.length * 2);
  const on: boolean[] = [];
  for (let k = 0; k < trees.length; k++) {
    const tr = trees[k];
    const p = scene.pools[TREE_POOL[tr.kind] ?? 'oak'];
    slots[k * 2] = add(p[Math.abs(tr.seed) % p.length], tr.gx, tr.gy, R_WOOD, k, tr.id);
    on.push(true);
    const st = scene.pools.stump;
    slots[k * 2 + 1] = add(st[Math.abs(tr.seed) % st.length], tr.gx, tr.gy, R_STUMP, k);
    on.push(false);
  }
  for (const p of scene.map.scatter) {
    const sp = propSprite(scene, p.kind, p.seed, '#63c9a8');
    if (sp) {
      add(sp, p.gx, p.gy, R_WOOD, trees.length + on.length);
      on.push(true);
    }
  }
  // Site dressing, in the order the per-frame pass used to push it: site by
  // site, prop by prop. `-1` is a kind with no art, which that pass skipped too.
  let np = 0;
  for (const s of scene.map.sites) np += s.props.length;
  const props = new Int32Array(np).fill(-1);
  let pi = 0;
  for (const site of scene.map.sites) {
    for (const p of site.props) {
      const sp = propSprite(scene, p.kind, p.seed, site.accent);
      if (sp) {
        props[pi] = add(sp, p.gx, p.gy, R_PROP, pi);
        on.push(false);
      }
      pi++;
    }
  }

  // MARKET — the pitches, after the dressing and on the same rank, so a stall
  // in front of a well is in front of it. Slots only; nothing is painted until
  // `syncVeg` sees nine in the morning.
  // MERGE NOTE: this block must run BEFORE the ruins block below — it indexes
  // slots with `pi++`, which is only aligned with `on.length` while every
  // earlier add used it too. The ruins block indexes with `on.length` directly
  // and is safe in any position.
  const stalls: number[] = [];
  for (const st of scene.stalls) {
    stalls.push(add(buildMarketStall(st.seed, st.accent), st.gx, st.gy, R_PROP, pi++));
    on.push(false);
  }

  /* ---- ruins (additive) -------------------------------------------------- */
  // Ruins are the easiest statics in the valley: they were here before the
  // first house and they will be here after the last lamp, so they go on at
  // build time and are never touched again. No slot, no reconcile, no patch —
  // just an item that is on from the moment the layer exists. The ghost joins
  // them on exactly the same terms; the only thing that makes it special is
  // where its shape came from.
  {
    const ruins = scene.map.ruins ?? [];
    const all = scene.ghost ? ruins.concat([scene.ghost]) : ruins;
    for (const r of all) {
      add(ruinSprite(scene, r), r.gx, r.gy, R_RUIN, on.length);
      on.push(true);
    }
  }
  /* ---- end ruins (additive) ---------------------------------------------- */

  yield;
  // Sorted by depth, then by the rank the old per-frame pass implied, then by
  // build order — for the wood, whose ordering predates all this, by `bx`.
  const order = items.map((_, i) => i);
  order.sort((a, b) => {
    const A = items[a];
    const B = items[b];
    return (
      A.depth - B.depth ||
      A.rank - B.rank ||
      (A.rank === R_WOOD ? A.bx - B.bx : A.ord - B.ord) ||
      a - b
    );
  });
  const pos = new Int32Array(items.length);
  for (let i = 0; i < order.length; i++) pos[order[i]] = i;
  const sorted = order.map((i) => items[i]);
  const sortedOn = order.map((i) => on[i]);
  for (let i = 0; i < slots.length; i++) slots[i] = pos[slots[i]];
  for (let i = 0; i < props.length; i++) if (props[i] >= 0) props[i] = pos[props[i]];
  for (let i = 0; i < stalls.length; i++) stalls[i] = pos[stalls[i]];

  yield;
  const grid = new Map<number, number[]>();
  sorted.forEach((it, i) => {
    const cx0 = Math.floor(it.bx / VCELL);
    const cx1 = Math.floor((it.bx + it.bw) / VCELL);
    const cy0 = Math.floor(it.by / VCELL);
    const cy1 = Math.floor((it.by + it.bh) / VCELL);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = vkey(cx, cy);
        const arr = grid.get(k);
        if (arr) arr.push(i);
        else grid.set(k, [i]);
      }
    }
  });

  const veg: VegLayer = {
    c,
    ctx,
    items: sorted,
    grid,
    on: sortedOn,
    size: -1,
    slots,
    felling: [],
    props,
    propSize: -1,
    stalls,
    stallOn: false,
  };
  yield;
  bakeVeg(scene, veg);
  return veg;
}

/** Always at the same rounded pixel, so a repair copy lands on the bake. */
function paintVeg(c: Ctx, it: VegItem): void {
  c.drawImage(it.sprite.c, Math.round(it.bx), Math.round(it.by));
}

function bakeVeg(scene: GenesisScene, veg: VegLayer): void {
  veg.ctx.clearRect(scene.lx, scene.ly, veg.c.width, veg.c.height);
  // `items` is already in depth order, so array order is paint order.
  for (let i = 0; i < veg.items.length; i++) if (veg.on[i]) paintVeg(veg.ctx, veg.items[i]);
}

/** Repaint one sprite-sized window of the layer from scratch. */
function patchVeg(veg: VegLayer, r: VegItem): void {
  const { ctx } = veg;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.bx, r.by, r.bw, r.bh);
  ctx.clip();
  ctx.clearRect(r.bx, r.by, r.bw, r.bh);
  const seen = new Set<number>();
  const hits: number[] = [];
  const cx0 = Math.floor(r.bx / VCELL);
  const cx1 = Math.floor((r.bx + r.bw) / VCELL);
  const cy0 = Math.floor(r.by / VCELL);
  const cy1 = Math.floor((r.by + r.bh) / VCELL);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const arr = veg.grid.get(vkey(cx, cy));
      if (!arr) continue;
      for (const idx of arr) {
        if (!veg.on[idx] || seen.has(idx)) continue;
        const s = veg.items[idx];
        if (s.bx > r.bx + r.bw || s.bx + s.bw < r.bx) continue;
        if (s.by > r.by + r.bh || s.by + s.bh < r.by) continue;
        seen.add(idx);
        hits.push(idx);
      }
    }
  }
  // Item indexes ascend with depth, so a numeric sort is a depth sort.
  hits.sort((a, b) => a - b);
  for (const idx of hits) paintVeg(ctx, veg.items[idx]);
  ctx.restore();
}

/**
 * Force the next `syncVeg` to reconcile from scratch. The forward paths below
 * lean on the snapshot only ever growing; a scrub backwards breaks that, so the
 * one call site that knows a scrub has happened says so.
 */
export function invalidateVeg(scene: GenesisScene): void {
  scene.veg.size = -1;
  scene.veg.propSize = -1;
}

/**
 * Reconcile the scenery layer with the snapshot.
 *
 * Two fingerprints keep this off the critical path. A tree only ever enters
 * `snap.trees` when the axe starts, so while the entry count is unchanged the
 * only trees that can have moved on are the ones already mid-chop — a list the
 * renderer wants anyway. Site dressing only ever appears, so `snap.props.size`
 * is a complete fingerprint of the whole set. Both are exact forwards; a
 * backwards scrub comes through `invalidateVeg` above and rescans everything.
 */
export function syncVeg(scene: GenesisScene, snap: WorldSnapshot): void {
  const veg = scene.veg;
  const changed: number[] = [];

  /** Flip one slot if the snapshot disagrees with the bake. */
  const want = (slot: number, wanted: boolean) => {
    if (slot >= 0 && veg.on[slot] !== wanted) changed.push(slot);
  };

  if (veg.size !== snap.trees.size) {
    veg.size = snap.trees.size;
    const trees = scene.map.trees;
    const felling: number[] = [];
    for (let k = 0; k < trees.length; k++) {
      const st = snap.trees.get(trees[k].id);
      if (st === 'felling') felling.push(k);
      want(veg.slots[k * 2], st === undefined || st === 'standing');
      want(veg.slots[k * 2 + 1], st === 'stump');
    }
    veg.felling = felling;
  } else if (veg.felling.length) {
    const trees = scene.map.trees;
    const felling: number[] = [];
    for (const k of veg.felling) {
      const st = snap.trees.get(trees[k].id);
      if (st === 'felling') {
        felling.push(k);
        continue;
      }
      want(veg.slots[k * 2], st === undefined || st === 'standing');
      want(veg.slots[k * 2 + 1], st === 'stump');
    }
    veg.felling = felling;
  }

  if (veg.propSize !== snap.props.size) {
    veg.propSize = snap.props.size;
    let pi = 0;
    for (const site of scene.map.sites) {
      for (const p of site.props) want(veg.props[pi++], snap.props.has(p.id));
    }
  }

  // MARKET — two transitions in a whole day, each of them two to four patches:
  // the trestles go up at nine and the awnings come down at dusk. Same
  // mechanism as a prop appearing, driven by the clock instead of by an event.
  if (veg.stalls.length) {
    const open = marketOpen(scene, snap);
    if (open !== veg.stallOn) {
      veg.stallOn = open;
      for (const i of veg.stalls) want(i, open);
    }
  }

  if (!changed.length) return;
  for (const i of changed) veg.on[i] = !veg.on[i];
  // A scrub can move hundreds of sprites at once; past a few dozen patches a
  // straight re-bake of the whole layer is the cheaper of the two.
  if (changed.length > 40) bakeVeg(scene, veg);
  else for (const i of changed) patchVeg(veg, veg.items[i]);
}

function hexRGB(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbHex(rgb: [number, number, number]): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const v = (c(rgb[0]) << 16) | (c(rgb[1]) << 8) | c(rgb[2]);
  return `#${(v | 0x1000000).toString(16).slice(1)}`;
}

/* ------------------------------ sprite lookup ---------------------------- */

function propSprite(
  scene: GenesisScene,
  kind: string,
  seed: number,
  accent: string
): Sprite | null {
  switch (kind) {
    case 'nameboard':
      return cached(scene, `nb:${accent}`, () => buildNameBoard(accent));
    case 'signpost':
      return cached(scene, `sg:${accent}`, () => buildSignpost(accent));
    case 'stake':
      return cached(scene, `sk:${accent}:${seed % 3}`, () => buildStake(accent, seed));
    case 'crane':
      return cached(scene, `cn:${accent}`, () => buildCrane(accent));
    default: {
      const p = scene.pools[kind];
      if (!p) return null;
      return p[Math.abs(seed) % p.length];
    }
  }
}

/* ---- ruins (additive) ---------------------------------------------------- */

/**
 * How much of the old wall height a ruin still has standing.
 *
 * A wall corner keeps about a third of one — four courses, which is what is
 * left when a building has been a quarry for its neighbours. A tower stub keeps
 * a good deal more, because the bottom of a round tower is the part nobody can
 * get the stones out of. The ghost is pinned at ~40%, whatever it used to be:
 * yesterday's landmark is meant to be recognisable by its FOOTPRINT and its
 * silhouette, not by being the tallest thing on the moor.
 */
const ruinStanding = (r: RuinSpec): number =>
  r.id === 'ghost' ? 0.4 : r.kind === 'tower' ? 0.38 : 0.55;

function ruinSprite(scene: GenesisScene, r: RuinSpec): Sprite {
  const key = `ru:${r.kind}:${r.w}:${r.floors}:${r.material ?? 't'}:${r.seed}`;
  return cached(scene, key, () =>
    r.kind === 'rubble'
      ? buildRubble(r.seed, r.w)
      : buildRuinWall({
          kind: r.kind,
          w: r.w,
          floors: r.floors,
          standing: ruinStanding(r),
          material: r.material,
          seed: r.seed,
        })
  );
}

/* ---- end ruins (additive) ------------------------------------------------ */

function cached(scene: GenesisScene, key: string, make: () => Sprite): Sprite {
  const hit = scene.extra.get(key);
  if (hit) return hit;
  const sp = make();
  scene.extra.set(key, sp);
  return sp;
}

function structFor(scene: GenesisScene, b: BuildingSpec, progress: number): StructureSprite {
  // Only a finished house lights its windows, and only after dark.
  const lit = scene.lit && progress >= 0.999;
  const stem = `${b.id}:${progress.toFixed(2)}`;
  const key = `${stem}:${lit ? 1 : 0}`;
  const hit = scene.structs.get(b.id);
  if (hit && hit.key === key) return hit.sp;
  if (hit && hit.key.startsWith(`${stem}:`)) {
    // Nothing changed but the lights. Rebaking every house on the one frame
    // dusk tips over would be a visible hitch, so the valley lights up over a
    // few frames instead — which is roughly how a valley lights up anyway.
    if (scene.relight <= 0) return hit.sp;
    scene.relight--;
  }
  const sp = buildStructure({
    role: b.role,
    accent: b.accent,
    w: b.w,
    floors: b.floors,
    roof: b.roof,
    progress,
    condition: 1,
    material: b.material,
    chimney: b.chimney,
    cupola: b.cupola,
    awning: b.awning,
    banner: b.banner,
    lit,
    seed: b.seed,
  });
  // One entry per building: the old progress step is never coming back except
  // on a scrub, where rebuilding it costs a fraction of a millisecond.
  scene.structs.set(b.id, { key, sp });
  return sp;
}

/* ------------------------------ ambient life ----------------------------- */

const BOT_COLORS = ['#ef7f93', '#63c9a8', '#9b8fe8', '#f0c75e', '#6cc4d9', '#e98fc3', '#f5a25d'];
/** What is on the bed of a hand cart: sacks, cut timber, hay, stone. */
const CARGO_COLORS = ['#c8a86a', '#a9743e', '#d8c06a', '#9aa3ad'];
const BOT_SPEED = 1.3; // tiles per second
const WALK_SPEED = 1.05;
/** A cart is freight, so it plods; a walker on foot overtakes it. */
const CART_SPEED = 0.72;

export function makeAmbient(pace = 1): Ambient {
  return {
    bots: [],
    crews: new Map(),
    pop: new Map(),
    walkers: [],
    diggers: [],
    sparks: [],
    opened: new Set(),
    smoke: [],
    smokeClock: { t: 0 },
    smokers: [],
    wheels: [],
    sig: '',
    rng: mulberry32(4242),
    pace: paceOf(pace),
  };
}

const paceOf = (p: number) => (Number.isFinite(p) ? Math.max(0.25, Math.min(4, p)) : 1);

/** How much faster legs and hammers move. */
const paceRate = (amb: Ambient) => Math.sqrt(amb.pace);

/** Extra hands per site once the valley is working above a normal day. */
const paceCrew = (amb: Ambient) =>
  amb.pace > 1 ? Math.min(2, Math.round(Math.sqrt(amb.pace))) : 0;

/** Retune the crowd for a new work pace. The next sync re-derives the counts. */
export function setAmbientPace(amb: Ambient, pace: number): void {
  const p = paceOf(pace);
  if (p === amb.pace) return;
  amb.pace = p;
  amb.sig = '';
}

/** A fingerprint of everything the ambient layer keys off. */
function snapSig(snap: WorldSnapshot): string {
  let b = 0;
  snap.buildings.forEach((v, k) => {
    b += k.length + v.status.charCodeAt(0) * 7 + Math.round(v.progress * 40);
  });
  let tr = 0;
  snap.trees.forEach((v) => {
    tr += v.charCodeAt(1);
  });
  let pop = 0;
  snap.population.forEach((v) => {
    pop += v;
  });
  let rd = 0;
  snap.roads.forEach((v) => {
    rd += Math.round(v * 20);
  });
  let ch = 0;
  snap.chests.forEach((v, k) => {
    ch += k.length + v.charCodeAt(0);
  });
  return (
    `${snap.founded.size}|${pop}|${b}|${tr}.${snap.trees.size}|${rd}|${snap.props.size}` +
    `|${ch}.${snap.chests.size}`
  );
}

interface Task {
  gx: number;
  gy: number;
  action: BotAction;
  /** Yard point a carrier shuttles back to. */
  ygx: number;
  ygy: number;
}

/**
 * The jobs going on at one site, in staffing order: a crew of `n` takes the
 * first `n`. So the order *is* the priority, and the errands at the bottom only
 * get a body when the real work is already covered — which is what keeps a
 * mature yard busy without doubling the crowd.
 */
function siteTasks(scene: GenesisScene, site: SiteSpec, snap: WorldSnapshot): Task[] {
  const out: Task[] = [];
  // Choppers first — a tree coming down is the most legible bit of work there
  // is, so it should never be the job that goes unstaffed. The same pass
  // remembers one felled stump, which is where the lumber haul below starts.
  let stump: TreeSpec | null = null;
  for (const b of site.buildings) {
    for (const id of b.clears) {
      const state = snap.trees.get(id);
      if (state === 'felling') {
        const tr = scene.treeById.get(id);
        if (tr)
          out.push({
            gx: tr.gx,
            gy: tr.gy,
            action: 'work',
            ygx: tr.gx,
            ygy: tr.gy,
          });
      } else if (state === 'stump' && !stump) {
        stump = scene.treeById.get(id) ?? null;
      }
    }
  }
  let plot: BuildingSpec | null = null;
  for (const b of site.buildings) {
    const st = snap.buildings.get(b.id);
    if (!st || st.status === 'unplanned' || st.status === 'done') continue;
    if (!plot) plot = b;
    out.push({ gx: b.gx, gy: b.gy, action: 'work', ygx: b.gx, ygy: b.gy });
    out.push({
      gx: b.gx,
      gy: b.gy,
      action: 'carry',
      ygx: site.gx + (b.gx - site.gx) * 0.25,
      ygy: site.gy + (b.gy - site.gy) * 0.25,
    });
  }

  /* ---- errands, only ever staffed by a spare pair of hands -------------- */
  // Timber off the stumps the site just made, up to whatever is being framed.
  if (plot && stump) {
    out.push({ gx: plot.gx, gy: plot.gy, action: 'carry', ygx: stump.gx, ygy: stump.gy });
  }
  // Water from the well, once there is a well to draw it from.
  for (const p of site.props) {
    if (p.kind !== 'well' || !snap.props.has(p.id)) continue;
    out.push({ gx: p.gx, gy: p.gy, action: 'carry', ygx: site.gx, ygy: site.gy });
    break;
  }
  return out;
}

/**
 * The road a newcomer to `site` would have walked in on: the built road back to
 * the oldest place it connects to, entered a few tiles short of the town so the
 * last of the journey happens on screen.
 *
 * Returns null if nothing leads here yet — the first settlers of a site are
 * already standing in the meadow when it is founded, with no road to arrive by.
 */
function arrivalOn(
  scene: GenesisScene,
  site: SiteSpec,
  snap: WorldSnapshot,
  rng: () => number
): Arrival | null {
  const sites = scene.map.sites;
  let best: RoadSpec | null = null;
  let bestAge = Infinity;
  for (const road of scene.map.roads) {
    if (road.from !== site.id && road.to !== site.id) continue;
    // Part-built roads stop in the middle of the wood; nobody arrives down one.
    if ((snap.roads.get(road.id) ?? 0) < 0.98) continue;
    const other = road.from === site.id ? road.to : road.from;
    // Sites are in founding order, so a lower index is the older neighbour.
    const age = sites.findIndex((s) => s.id === other);
    if (age >= 0 && age < bestAge) {
      bestAge = age;
      best = road;
    }
  }
  if (!best) return null;
  const geo = scene.roadGeo.get(best.id)!;
  const pts = best.pts;
  const head = pts[0];
  const tail = pts[pts.length - 1];
  const atHead =
    Math.hypot(head[0] - site.gx, head[1] - site.gy) <=
    Math.hypot(tail[0] - site.gx, tail[1] - site.gy);
  const back = Math.min(geo.len * 0.55, 5 + rng() * 4);
  return { roadId: best.id, s: atHead ? back : geo.len - back, dir: atHead ? -1 : 1 };
}

function wanderPoint(site: SiteSpec, snap: WorldSnapshot, rng: () => number): Vec2 {
  const done = site.buildings.filter((b) => snap.buildings.get(b.id)?.status === 'done');
  if (done.length && rng() < 0.65) {
    const b = done[Math.floor(rng() * done.length)];
    return [b.gx + (rng() - 0.5) * 2.4, b.gy + (rng() - 0.5) * 2.4];
  }
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(rng()) * site.radius * 0.8;
  return [site.gx + Math.cos(a) * r, site.gy + Math.sin(a) * r];
}

/** Re-derive bot counts, smoke anchors and mill wheels from the snapshot. */
export function syncAmbient(scene: GenesisScene, amb: Ambient, snap: WorldSnapshot): void {
  // MARKET — the crowd on the roads is the one thing here that changes on the
  // clock rather than on an event, so the market's two transitions have to be
  // part of the fingerprint or the sync would sleep straight through them.
  const sig = snapSig(snap) + (marketOpen(scene, snap) ? '|mk' : '');
  if (sig === amb.sig) return;
  amb.sig = sig;
  const rng = amb.rng;

  /* ---- population ------------------------------------------------------ */
  // Regroup the standing crowd by site once, rather than re-filtering the whole
  // population for every one of up to eight towns.
  const crews = amb.crews;
  for (const arr of crews.values()) arr.length = 0;
  for (const b of amb.bots) {
    const arr = crews.get(b.site);
    if (arr) arr.push(b);
    else crews.set(b.site, [b]);
  }

  const extra = paceCrew(amb);
  const next: Bot[] = [];
  for (const site of scene.map.sites) {
    const founded = snap.founded.has(site.id);
    const want = founded
      ? Math.max(1, Math.min((snap.population.get(site.id) ?? 1) + extra, 8 + extra))
      : 0;
    let mine = crews.get(site.id);
    if (!mine) {
      mine = [];
      crews.set(site.id, mine);
    }
    const had = mine.length;
    if (had > want) mine.length = want;

    // A town that gains settlers has had people *arrive*, and people arrive on
    // the road. Only a town that already existed can be walked into: the first
    // pair of a new site are the ones who founded it, and are simply there.
    const was = amb.pop.get(site.id) ?? 0;
    const now = snap.population.get(site.id) ?? 0;
    amb.pop.set(site.id, now);
    let walkIn = had > 0 && now > was ? Math.min(2, want - had) : 0;

    for (let i = had; i < want; i++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * site.radius * 0.6;
      const bot: Bot = {
        site: site.id,
        slot: i,
        gx: site.gx + Math.cos(a) * r,
        gy: site.gy + Math.sin(a) * r,
        tx: site.gx,
        ty: site.gy,
        action: 'idle',
        timer: rng() * 2,
        phase: rng() * 10,
        color: BOT_COLORS[Math.floor(rng() * BOT_COLORS.length)],
        faceRight: rng() < 0.5,
        jx: (rng() - 0.5) * 1.8,
        jy: (rng() - 0.5) * 1.8,
        leg: 0,
        arrive: null,
      };
      if (walkIn > 0) {
        const arr = arrivalOn(scene, site, snap, rng);
        if (arr) {
          const geo = scene.roadGeo.get(arr.roadId)!;
          const at = alongPolyline(scene.roadById.get(arr.roadId)!.pts, geo, arr.s);
          bot.gx = at[0];
          bot.gy = at[1];
          bot.action = 'walk';
          bot.arrive = arr;
          walkIn--;
        }
      }
      mine.push(bot);
    }
    for (const b of mine) next.push(b);
  }
  amb.bots = next;
  amb.bots.forEach((b, i) => {
    b.slot = i;
  });

  /* ---- road traffic ---------------------------------------------------- */
  // A highway is the road freight uses, so it gets a hand cart as well as a
  // walker; a lane or a track only ever carries people.
  amb.walkers = amb.walkers.filter((w) => (snap.roads.get(w.roadId) ?? 0) > 0.5);
  const onRoad = new Map<string, number>();
  for (const w of amb.walkers) onRoad.set(w.roadId, (onRoad.get(w.roadId) ?? 0) + 1);
  // MARKET — while the stalls are up, the roads that lead to them carry the
  // people going. Empty on every other day, and empty again once they come down.
  const extraTraffic = marketOpen(scene, snap) ? marketTraffic(scene) : null;
  for (const road of scene.map.roads) {
    const frac = snap.roads.get(road.id) ?? 0;
    if (frac <= 0.5) continue;
    const highway = road.kind === 'highway';
    const base = highway ? 2 : 1;
    const boost = extraTraffic?.get(road.id) ?? 0;
    const want = base + boost;
    const have = onRoad.get(road.id) ?? 0;
    const geo = scene.roadGeo.get(road.id)!;
    for (let i = have; i < want; i++) {
      const s = geo.len * frac * rng();
      const at = alongPolyline(road.pts, geo, s);
      // The coin is always tossed, so that a market day cannot shift the colour
      // and gait of the ordinary walkers that share the road with the crowd.
      const coin: 1 | -1 = rng() < 0.5 ? 1 : -1;
      const going = boost > 0 && i >= base ? marketward(scene, road) : 0;
      amb.walkers.push({
        roadId: road.id,
        s,
        dir: going || coin,
        phase: rng() * 8,
        color: BOT_COLORS[Math.floor(rng() * BOT_COLORS.length)],
        gx: at[0],
        gy: at[1],
        faceRight: true,
        // Freight goes to market too: one more loaded cart on a market highway.
        cart: highway && (i === 0 || (going !== 0 && i === base)),
        cargo: CARGO_COLORS[Math.floor(rng() * CARGO_COLORS.length)],
      });
    }
    // …and once the awnings come down, the road empties again.
    if (have > want) {
      let drop = have - want;
      for (let i = amb.walkers.length - 1; i >= 0 && drop > 0; i--) {
        if (amb.walkers[i].roadId === road.id) {
          amb.walkers.splice(i, 1);
          drop--;
        }
      }
    }
  }

  syncDiggers(scene, amb, snap);

  /* ---- chimneys and wheels --------------------------------------------- */
  amb.smokers = [];
  amb.wheels = [];
  for (const site of scene.map.sites) {
    for (const b of site.buildings) {
      const st = snap.buildings.get(b.id);
      if (!st || st.status === 'unplanned') continue;
      const sp = structFor(scene, b, st.progress);
      const bx = isoX(b.gx, b.gy);
      const by = isoY(b.gx, b.gy);
      if (sp.smoke && st.status === 'done') {
        amb.smokers.push({ x: bx + sp.smoke[0], y: by + sp.smoke[1] });
      }
      if (sp.wheel) amb.wheels.push({ x: bx + sp.wheel[0], y: by + sp.wheel[1] });
    }
  }
}

/* --------------------------- discovery theatre --------------------------- */

/** How far out the finder starts walking from, in tiles. */
const DIG_APPROACH = 6.5;
const DIG_SPEED = 1.15;

/**
 * Staff the chests. One digger appears as soon as the timeline says somebody is
 * turning earth over a chest, walking in from whichever town is going to claim
 * it; when the lid comes up they turn round and take the news home, and the
 * moment itself throws a handful of pixels into the air.
 *
 * This is ambience, so it is allowed to be approximate: the walk is a straight
 * line over whatever is in the way, and the arrival is timed by the length of
 * the approach rather than by the clock.
 */
function syncDiggers(scene: GenesisScene, amb: Ambient, snap: WorldSnapshot): void {
  const chests = scene.map.chests ?? [];
  const rng = amb.rng;
  const live = new Map(amb.diggers.map((d) => [d.chestId, d]));

  for (const chest of chests) {
    const state = snap.chests.get(chest.id);
    if (!state) continue;

    /* ---- the moment ---------------------------------------------------- */
    if (state === 'open' && !amb.opened.has(chest.id)) {
      amb.opened.add(chest.id);
      const x = isoX(chest.gx, chest.gy);
      const y = isoY(chest.gx, chest.gy);
      for (let i = 0; i < 24; i++) {
        const a = -Math.PI / 2 + (rng() - 0.5) * 2.2;
        // World pixels per second: slow enough that the burst still reads at a
        // close zoom, where a fast pixel is off the screen before it is seen.
        const sp = 9 + rng() * 20;
        amb.sparks.push({
          x: x + (rng() - 0.5) * 9,
          y: y - 12,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          age: 0,
          color: rng() < 0.35 ? '#ffffff' : rng() < 0.6 ? '#ffeaa8' : '#f2cc63',
        });
      }
    }

    /* ---- the finder ----------------------------------------------------- */
    let d = live.get(chest.id);
    if (!d) {
      // Walk in from the town that is going to claim it, or from the nearest
      // town that exists yet — somebody has to have come from somewhere.
      let home: SiteSpec | null = null;
      let best = Infinity;
      for (const s of scene.map.sites) {
        if (!snap.founded.has(s.id)) continue;
        if (s.id === chest.siteId) {
          home = s;
          break;
        }
        const dd = Math.hypot(s.gx - chest.gx, s.gy - chest.gy);
        if (dd < best) {
          best = dd;
          home = s;
        }
      }
      let ux = home ? home.gx - chest.gx : 1;
      let uy = home ? home.gy - chest.gy : 1;
      const l = Math.hypot(ux, uy) || 1;
      ux /= l;
      uy /= l;
      d = {
        chestId: chest.id,
        gx: chest.gx + ux * DIG_APPROACH,
        gy: chest.gy + uy * DIG_APPROACH,
        // They walk in from their own town but always end up on the near side
        // of the hole, and a little to the right of it, so the finder never
        // stands between the camera and the lid however they came in.
        tx: chest.gx + 1.4,
        ty: chest.gy + 0.3,
        hx: home ? home.gx : chest.gx + ux * 14,
        hy: home ? home.gy : chest.gy + uy * 14,
        phase: rng() * 10,
        color: BOT_COLORS[Math.floor(rng() * BOT_COLORS.length)],
        faceRight: ux - uy < 0,
        action: 'walk',
        leg: 0,
      };
      // A chest already open when the snapshot arrives (a scrub, or a deep
      // link straight to the evening) has no walk left to perform.
      if (state === 'open') {
        d.leg = 1;
        d.tx = d.hx;
        d.ty = d.hy;
      }
      amb.diggers.push(d);
      live.set(chest.id, d);
    } else if (state === 'open' && d.leg === 0) {
      d.leg = 1;
      d.tx = d.hx;
      d.ty = d.hy;
      d.action = 'walk';
    }
  }

  // A chest that went back to being buried (a scrub backwards) loses its finder.
  amb.diggers = amb.diggers.filter((d) => snap.chests.has(d.chestId));
  for (const chest of chests) if (!snap.chests.has(chest.id)) amb.opened.delete(chest.id);
}

function stepDiggers(amb: Ambient, dt: number, rate: number): void {
  for (let i = amb.diggers.length - 1; i >= 0; i--) {
    const d = amb.diggers[i];
    d.phase += dt * rate;
    const dx = d.tx - d.gx;
    const dy = d.ty - d.gy;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.2) {
      // Arrived: either at the chest, where there is digging to do, or home,
      // where there is nothing left to draw.
      if (d.leg === 1) amb.diggers.splice(i, 1);
      else d.action = 'work';
      continue;
    }
    const step = Math.min(dist, DIG_SPEED * rate * dt);
    d.gx += (dx / dist) * step;
    d.gy += (dy / dist) * step;
    const sdx = dx - dy;
    if (Math.abs(sdx) > 0.01) d.faceRight = sdx > 0;
    d.action = 'walk';
  }

  for (let i = amb.sparks.length - 1; i >= 0; i--) {
    const s = amb.sparks[i];
    s.age += dt;
    if (s.age > 1.5) {
      amb.sparks.splice(i, 1);
      continue;
    }
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vy += 40 * dt;
  }
}

/** Everything freezes mid-pose while the player is paused; this is only called
 * when the clock is actually running. */
export function stepAmbient(
  scene: GenesisScene,
  amb: Ambient,
  snap: WorldSnapshot,
  dtIn: number
): void {
  // The crews shelter while it rains, which is the same thing the timeline
  // does to the work itself — the valley slows down and then hurries.
  const dt = dtIn * workPace(scene.day, snap.t);
  const rng = amb.rng;
  const rate = paceRate(amb);
  // FESTIVAL — on an evening the valley earned, the founding town's crew stops
  // being a crew. Resolved once per tick rather than per bot.
  const party = festivalOn(scene, snap) ? scene.fire : null;
  const partySite = party ? scene.map.sites[0].id : '';

  for (const site of scene.map.sites) {
    if (!snap.founded.has(site.id)) continue;
    const crew = amb.crews.get(site.id);
    if (!crew || !crew.length) continue;
    const tasks = siteTasks(scene, site, snap);
    const circle = party && site.id === partySite ? party : null;

    crew.forEach((bot, i) => {
      bot.phase += dt * rate;
      if (bot.arrive) {
        stepArrival(scene, bot, site, dt, rate);
        return;
      }
      if (circle) {
        gatherRound(bot, i, crew.length, circle, dt, rate, rng);
        return;
      }
      const task = tasks.length ? tasks[i % tasks.length] : null;

      if (task) {
        const goal: Vec2 =
          task.action === 'carry' && bot.leg === 1
            ? [task.ygx + bot.jx, task.ygy + bot.jy]
            : [task.gx + bot.jx * 0.9 + 1.1, task.gy + bot.jy * 0.9 + 1.1];
        bot.tx = goal[0];
        bot.ty = goal[1];
        const moved = moveTo(bot, dt, task.action === 'carry' ? 'carry' : 'walk', rate);
        if (!moved) {
          if (task.action === 'carry') {
            bot.action = 'carry';
            bot.timer -= dt;
            if (bot.timer <= 0) {
              bot.leg = bot.leg === 0 ? 1 : 0;
              bot.timer = 1.2 + rng() * 1.6;
            }
          } else {
            bot.action = rng() < 0.004 ? 'idle' : 'work';
          }
        }
        return;
      }

      // Nothing to build: drift between the finished houses.
      const moving = moveTo(bot, dt, 'walk', rate);
      if (!moving) {
        bot.action = 'idle';
        bot.timer -= dt;
        if (bot.timer <= 0) {
          const p = wanderPoint(site, snap, rng);
          bot.tx = p[0];
          bot.ty = p[1];
          bot.timer = 1 + rng() * 3.5;
          bot.action = 'walk';
        }
      }
    });
  }

  for (const w of amb.walkers) {
    const road = scene.roadById.get(w.roadId);
    if (!road) continue;
    const geo = scene.roadGeo.get(road.id)!;
    const end = geo.len * (snap.roads.get(road.id) ?? 0);
    w.phase += dt * rate;
    w.s += (w.cart ? CART_SPEED : WALK_SPEED) * rate * dt * w.dir;
    if (w.s >= end) {
      w.s = end;
      w.dir = -1;
    } else if (w.s <= 0) {
      w.s = 0;
      w.dir = 1;
    }
    const at = alongPolyline(road.pts, geo, w.s);
    const sdx = at[0] - w.gx - (at[1] - w.gy);
    if (Math.abs(sdx) > 0.001) w.faceRight = sdx > 0;
    w.gx = at[0];
    w.gy = at[1];
  }

  stepDiggers(amb, dt, rate);
  stepSmoke(amb, dt);
}

/**
 * FESTIVAL — one settler standing at a fire.
 *
 * A loose ring rather than a tidy one: the slot is `i`'s share of the circle,
 * nudged by the jitter the bot has carried since it was made, so the same
 * settler always stands in the same place and the circle is never a clock face.
 * They face inwards, and they shuffle every few seconds, because the whole
 * point of the shot is that the valley is *standing about*.
 */
function gatherRound(
  bot: Bot,
  i: number,
  n: number,
  fire: Vec2,
  dt: number,
  rate: number,
  rng: () => number
): void {
  const a = (i / Math.max(1, n)) * Math.PI * 2 + bot.jx * 0.5;
  const r = 1.9 + (i % 3) * 0.4 + bot.jy * 0.16;
  bot.tx = fire[0] + Math.cos(a) * r;
  bot.ty = fire[1] + Math.sin(a) * r;
  if (moveTo(bot, dt, 'walk', rate)) return;
  bot.action = 'idle';
  // Face the fire: in screen space, that is whichever side of it they are on.
  bot.faceRight = bot.gx - bot.gy < fire[0] - fire[1];
  bot.timer -= dt;
  if (bot.timer <= 0) {
    bot.timer = 2.5 + rng() * 4;
    // Clamped, because this is a random walk and an hour of it would otherwise
    // put somebody in the river.
    const pen = (v: number) => (v < -2 ? -2 : v > 2 ? 2 : v);
    bot.jx = pen(bot.jx + (rng() - 0.5) * 0.5);
    bot.jy = pen(bot.jy + (rng() - 0.5) * 0.5);
  }
}

/**
 * Walk a newcomer the last few tiles of their journey, along the road, and put
 * them into the site's crew when they get there. Until then they take no task:
 * you cannot frame a wall you have not reached yet.
 */
function stepArrival(
  scene: GenesisScene,
  bot: Bot,
  site: SiteSpec,
  dt: number,
  rate: number
): void {
  const a = bot.arrive!;
  const road = scene.roadById.get(a.roadId);
  const geo = road ? scene.roadGeo.get(a.roadId) : undefined;
  if (!road || !geo) {
    bot.arrive = null;
    return;
  }
  a.s += WALK_SPEED * rate * dt * a.dir;
  const home = a.dir < 0 ? a.s <= 0 : a.s >= geo.len;
  if (home) a.s = a.dir < 0 ? 0 : geo.len;
  const at = alongPolyline(road.pts, geo, a.s);
  const sdx = at[0] - bot.gx - (at[1] - bot.gy);
  if (Math.abs(sdx) > 0.001) bot.faceRight = sdx > 0;
  bot.gx = at[0];
  bot.gy = at[1];
  bot.action = 'walk';
  // The road stops at the edge of town as often as at its middle, so either
  // running out of road or simply reaching the place counts as arriving.
  if (home || Math.hypot(bot.gx - site.gx, bot.gy - site.gy) < 1.4) {
    bot.arrive = null;
    bot.tx = site.gx + bot.jx;
    bot.ty = site.gy + bot.jy;
    bot.timer = 0.5;
  }
}

/** @returns true while the bot is still travelling. */
function moveTo(bot: Bot, dt: number, action: BotAction, rate = 1): boolean {
  const dx = bot.tx - bot.gx;
  const dy = bot.ty - bot.gy;
  const d = Math.hypot(dx, dy);
  if (d < 0.18) return false;
  const step = BOT_SPEED * rate * dt;
  if (d <= step) {
    bot.gx = bot.tx;
    bot.gy = bot.ty;
    return false;
  }
  bot.gx += (dx / d) * step;
  bot.gy += (dy / d) * step;
  const sdx = dx - dy;
  if (Math.abs(sdx) > 0.01) bot.faceRight = sdx > 0;
  bot.action = action;
  return true;
}

function stepSmoke(amb: Ambient, dt: number): void {
  amb.smokeClock.t += dt;
  if (amb.smokeClock.t > 0.6) {
    amb.smokeClock.t = 0;
    for (const s of amb.smokers) {
      amb.smoke.push({ x: s.x, y: s.y, age: 0, drift: amb.rng() * 6 });
    }
  }
  for (let i = amb.smoke.length - 1; i >= 0; i--) {
    amb.smoke[i].age += dt;
    if (amb.smoke[i].age > 3.6) amb.smoke.splice(i, 1);
  }
}

/** Scrubbing backwards throws the whole ambient layer away and re-seeds it. */
export function resetAmbient(scene: GenesisScene, amb: Ambient, snap: WorldSnapshot): void {
  // The baked scenery is derived from the snapshot too, and its cheap forward
  // fingerprints assume the day only ever moves on. This is the one call site
  // that knows it has not, so it is where the bake is told to start again.
  invalidateVeg(scene);
  amb.bots = [];
  amb.crews.clear();
  amb.pop.clear();
  amb.walkers = [];
  amb.diggers = [];
  amb.sparks = [];
  amb.opened.clear();
  amb.smoke = [];
  amb.smokeClock.t = 0;
  amb.sig = '';
  amb.rng = mulberry32(4242);
  syncAmbient(scene, amb, snap);
  resetWildlife(scene, amb, snap); // WILDLIFE — same call site, same reproducibility
}

/** Settle the crowd so a paused or reduced-motion visitor gets a lived-in world. */
export function settleAmbient(scene: GenesisScene, amb: Ambient, snap: WorldSnapshot): void {
  syncAmbient(scene, amb, snap);
  // Settling is measured in world seconds, not weather ones: a crowd dropped
  // into the middle of a storm still has to finish walking to where it lives.
  const k = 1 / Math.max(0.05, workPace(scene.day, snap.t));
  for (let i = 0; i < 120; i++) stepAmbient(scene, amb, snap, k / 12);
}

/* ==================== MARKET DAY, and the FESTIVAL ======================== *
 * Two evenings' worth of presentation, both derived and neither stored: the
 * market from `scene.day`, the festival from `scene.fest` plus the clock. No
 * timeline event carries either one, so a scrub to 09:00 and back is exactly a
 * scrub, and a paused world at 20:30 is the same world it was a frame ago.
 * -------------------------------------------------------------------------- */

/** Are the stalls up? Not before the town they came to exists. */
function marketOpen(scene: GenesisScene, snap: WorldSnapshot): boolean {
  const m = scene.market;
  if (!m || !scene.stalls.length) return false;
  return snap.t >= scene.day.from && snap.t < scene.day.to && snap.founded.has(m.id);
}

/**
 * Extra walkers per road on a market day, keyed by road id.
 *
 * Everybody is going the same way, so the traffic thins with distance from the
 * market: a road that ends in the market town carries three more than usual, a
 * road into one of *its* neighbours carries one, and the far side of the valley
 * has an ordinary Tuesday. Capped, because the road network at pace 4 is
 * seventeen roads and the crowd is the frame's most expensive thing.
 */
function marketTraffic(scene: GenesisScene): Map<string, number> {
  const out = new Map<string, number>();
  const m = scene.market;
  if (!m) return out;
  const near = new Set<string>([m.id]);
  for (const r of scene.map.roads) {
    if (r.from === m.id) near.add(r.to);
    else if (r.to === m.id) near.add(r.from);
  }
  let budget = 14;
  for (const r of scene.map.roads) {
    const hub = r.from === m.id || r.to === m.id;
    const spoke = near.has(r.from) || near.has(r.to);
    const n = Math.min(budget, hub ? 3 : spoke ? 1 : 0);
    if (n > 0) {
      out.set(r.id, n);
      budget -= n;
    }
  }
  return out;
}

/** Which way along `road` the market lies: +1 towards its tail, -1 to its head. */
function marketward(scene: GenesisScene, road: RoadSpec): 1 | -1 | 0 {
  const m = scene.market;
  if (!m) return 0;
  const head = road.pts[0];
  const tail = road.pts[road.pts.length - 1];
  return Math.hypot(tail[0] - m.gx, tail[1] - m.gy) <= Math.hypot(head[0] - m.gx, head[1] - m.gy)
    ? 1
    : -1;
}

/** Is the fire lit? Only on a day the valley earned, and only after dark. */
function festivalOn(scene: GenesisScene, snap: WorldSnapshot): boolean {
  return scene.fest > 0 && snap.t >= scene.fest && !!scene.fire;
}

/** One string of pennants, and where it hangs. */
interface Bunting {
  sprite: Sprite;
  /** World pixel of the near anchor, and the depth the string draws at. */
  x: number;
  y: number;
  depth: number;
}

const BUNTING = new WeakMap<GenesisScene, Bunting[]>();

/**
 * Strings between the roofs of the founding town, left to right.
 *
 * Baked once per scene and then only drawn: the anchors come off `roofPeak`,
 * which is the same arithmetic `buildStructure` uses for the ridge, so the
 * string is tied to the roof rather than to a guess about where the roof is.
 * Consecutive-in-x pairs only — that is how a village hangs bunting, and it
 * also guarantees the strings never cross.
 */
function buntingFor(scene: GenesisScene): Bunting[] {
  const hit = BUNTING.get(scene);
  if (hit) return hit;
  const out: Bunting[] = [];
  const site = scene.map.sites[0];
  if (site) {
    const tops = site.buildings
      .map((b) => ({
        x: isoX(b.gx, b.gy),
        y: isoY(b.gx, b.gy),
        top: isoY(b.gx, b.gy) - roofPeak(b.w, b.floors, b.roof) + 2,
        seed: b.seed,
      }))
      .sort((a, b) => a.x - b.x || a.y - b.y);
    for (let i = 0; i + 1 < tops.length && out.length < 4; i++) {
      const a = tops[i];
      const b = tops[i + 1];
      const dx = b.x - a.x;
      const dy = b.top - a.top;
      // Too far apart and it is a rope, not bunting; too close and the two
      // roofs are the same silhouette and the string disappears into them.
      const span = Math.hypot(dx, dy);
      if (span < 22 || span > 130) continue;
      out.push({
        sprite: buildBunting(dx, dy, a.seed ^ b.seed),
        x: a.x,
        y: a.top,
        depth: Math.max(a.y, b.y) + 3,
      });
    }
  }
  BUNTING.set(scene, out);
  return out;
}

/* ====================== rare days, and the turning year ==================== *
 * Everything in this block is presentation. `gen.ts` never hears about it: a
 * seed's terrain bytes are the same in January as in July, and the season is a
 * parameter carried into the *bake* and the *overlays* only.
 * -------------------------------------------------------------------------- */

/** Hue-rotate/desaturate helpers. Pixel art, so this only ever runs at bake. */
function rgbHSL(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const mx = Math.max(R, G, B);
  const mn = Math.min(R, G, B);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === R) h = ((G - B) / d + (G < B ? 6 : 0)) * 60;
  else if (mx === G) h = ((B - R) / d + 2) * 60;
  else h = ((R - G) / d + 4) * 60;
  return [h, s, l];
}

function hslRGB(h: number, s: number, l: number): [number, number, number] {
  const H = ((h % 360) + 360) % 360;
  const S = s < 0 ? 0 : s > 1 ? 1 : s;
  const L = l < 0 ? 0 : l > 1 ? 1 : l;
  if (S === 0) {
    const v = Math.round(L * 255);
    return [v, v, v];
  }
  const q = L < 0.5 ? L * (1 + S) : L + S - L * S;
  const p = 2 * L - q;
  const ch = (tc: number) => {
    let t = tc;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(ch(H / 360 + 1 / 3) * 255),
    Math.round(ch(H / 360) * 255),
    Math.round(ch(H / 360 - 1 / 3) * 255),
  ];
}

/**
 * One leaf pixel, moved into another season.
 *
 * Autumn walks green hues into the amber band and leaves an already-warm
 * hedgerow more or less alone; winter takes the colour out and the light up;
 * spring pulls everything towards new yellow-green and brightens it. Summer is
 * the art as drawn, so it never gets here at all.
 */
function seasonLeaf(season: Season, r: number, g: number, b: number): [number, number, number] {
  const [h, s, l] = rgbHSL(r, g, b);
  const green = h >= 60 && h <= 205;
  switch (season) {
    case 'autumn':
      return hslRGB(
        green ? 22 + ((h - 60) / 145) * 30 : h >= 285 ? 34 : h,
        Math.min(0.8, s * 1.02 + 0.14),
        Math.min(0.74, l * 0.99)
      );
    case 'winter':
      return hslRGB(h + (168 - h) * 0.22, s * 0.34, Math.min(0.9, l * 1.0 + 0.09));
    case 'spring':
      return hslRGB(
        green ? h + (98 - h) * 0.45 : h,
        Math.min(0.82, s * 1.04 + 0.05),
        Math.min(0.88, l * 1.04 + 0.05)
      );
    default:
      return [r, g, b];
  }
}

/** Trunks, bark and birch chalk: flat palette colours that stay where they are. */
const BARK = new Set(
  [PAL.wood, PAL.woodDark, PAL.woodLight, PAL.ink, '#efe9dc', '#cbc2b0', '#e2dbcb'].map(
    (hex) => parseInt(hex.slice(1), 16) & 0xffffff
  )
);

/**
 * Repaint one already-baked canvas into a season, in place.
 *
 * Doing it on the finished pixels rather than inside the sprite factories is
 * what keeps `art.ts` out of this entirely: the Vale shares that module and its
 * palette, and neither is touched. Everything opaque that is not on the bark
 * list is foliage; the soft shadow diamond under each tree is part-transparent
 * and is skipped by the same test.
 *
 * `blend` < 1 leaves the canvas partway between the two seasons, which is what
 * the deep-woodland surround wants: it is mostly conifer and only half turns.
 */
function seasonCanvas(c: HTMLCanvasElement, season: Season, blend = 1): void {
  if (season === 'summer' || c.width < 1 || c.height < 1) return;
  const g = c.getContext('2d');
  if (!g) return;
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 250) continue;
    if (BARK.has((d[i] << 16) | (d[i + 1] << 8) | d[i + 2])) continue;
    const [nr, ng, nb] = seasonLeaf(season, d[i], d[i + 1], d[i + 2]);
    d[i] = d[i] + (nr - d[i]) * blend;
    d[i + 1] = d[i + 1] + (ng - d[i + 1]) * blend;
    d[i + 2] = d[i + 2] + (nb - d[i + 2]) * blend;
  }
  g.putImageData(img, 0, 0);
}

/** The pools with leaves that turn. Pine and fir are evergreen and stay put. */
const DECIDUOUS = ['oak', 'blossom', 'hedgerow', 'birch', 'willow', 'bush'];

/** The ground, one season on. Frost-pale, fresh, as-drawn, or dry and warm. */
function seasonGround(hex: string, season: Season): string {
  switch (season) {
    case 'winter':
      return mix(hex, '#c6d4d1', 0.46);
    case 'spring':
      return mix(hex, '#b8e28c', 0.24);
    case 'autumn':
      return mix(hex, '#d6ba74', 0.36);
    default:
      return hex;
  }
}

/* ------------------------------ the overlays ----------------------------- */

/**
 * Mist. A flat wash that is heaviest at the far edge and again at the near one,
 * with three slow banks drifting through the middle of it. Screen-space, in
 * device pixels, and gone by half past nine.
 */
function paintMist(ctx: Ctx, m: number, dw: number, dh: number, clock: number): void {
  const wash = ctx.createLinearGradient(0, 0, 0, dh);
  wash.addColorStop(0, `rgba(228,238,242,${0.66 * m})`);
  wash.addColorStop(0.46, `rgba(222,233,239,${0.3 * m})`);
  wash.addColorStop(1, `rgba(212,226,235,${0.52 * m})`);
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, dw, dh);
  for (let i = 0; i < 3; i++) {
    const h = dh * 0.15;
    const y = dh * (0.3 + i * 0.24) + Math.sin(clock * 0.05 + i * 2.1) * dh * 0.035;
    const band = ctx.createLinearGradient(0, y - h, 0, y + h);
    band.addColorStop(0, 'rgba(238,246,248,0)');
    band.addColorStop(0.5, `rgba(238,246,248,${0.2 * m})`);
    band.addColorStop(1, 'rgba(238,246,248,0)');
    ctx.fillStyle = band;
    ctx.fillRect(0, y - h, dw, h * 2);
  }
}

/**
 * Rain. Two parallax sheets of diagonal streaks, seeded so each streak keeps
 * its column frame to frame and only falls; `clock` stands still for a visitor
 * who asked for reduced motion, which leaves a calm still of wet air.
 */
function paintRain(
  ctx: Ctx,
  s: number,
  dw: number,
  dh: number,
  clock: number,
  dpr: number,
  seed: number
): void {
  ctx.save();
  ctx.fillStyle = `rgba(126,142,164,${0.14 * s})`;
  ctx.fillRect(0, 0, dw, dh);
  const slant = 0.3;
  for (let L = 0; L < 2; L++) {
    const n = L === 0 ? 90 : 130;
    const len = (L === 0 ? 26 : 15) * dpr;
    const fall = (L === 0 ? 1500 : 950) * dpr;
    const rng = mulberry32(((seed >>> 0) ^ (L === 0 ? 0x9e37 : 0x7f4a)) >>> 0);
    ctx.strokeStyle = `rgba(224,236,246,${(L === 0 ? 0.42 : 0.24) * s})`;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const col = rng() * (dw + dh * slant);
      const ph = rng();
      const y = ((ph * (dh + len) + clock * fall) % (dh + len)) - len;
      const x = col - y * slant;
      ctx.moveTo(x, y);
      ctx.lineTo(x + len * slant, y + len);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * One aurora curtain, baked once: a soft vertical band, raked into rays, then
 * masked so it hangs off the top of the frame and fades out before the middle.
 * Two of them (green and violet) serve every aurora night there will ever be.
 */
function curtainSprite(rgb: string, seed: number): HTMLCanvasElement {
  const W = 192;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const across = g.createLinearGradient(0, 0, W, 0);
  across.addColorStop(0, `rgba(${rgb},0)`);
  across.addColorStop(0.5, `rgba(${rgb},1)`);
  across.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = across;
  g.fillRect(0, 0, W, H);
  // Rays: an aurora is a curtain seen edge-on, so it is striped, not smooth.
  const rng = mulberry32(seed);
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 26; i++) {
    g.fillStyle = `rgba(0,0,0,${0.14 + rng() * 0.42})`;
    g.fillRect(rng() * W, 0, 1 + rng() * 4, H);
  }
  g.globalCompositeOperation = 'destination-in';
  const down = g.createLinearGradient(0, 0, 0, H);
  down.addColorStop(0, 'rgba(0,0,0,1)');
  down.addColorStop(0.3, 'rgba(0,0,0,0.8)');
  down.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = down;
  g.fillRect(0, 0, W, H);
  return c;
}

let CURTAINS: HTMLCanvasElement[] | null = null;

/**
 * Aurora. Three curtains across the top of the frame, added rather than laid
 * over, so they can only ever brighten a sky that is already dark. The sway is
 * slow enough to read as standing still, and stops dead for a visitor who asked
 * for reduced motion — `clock` is the animation loop's, and that loop does not
 * run for them.
 */
function paintAurora(ctx: Ctx, a: number, dw: number, dh: number, clock: number): void {
  if (!CURTAINS) CURTAINS = [curtainSprite('92,238,172', 4711), curtainSprite('152,112,250', 911)];
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.imageSmoothingEnabled = true;
  for (let b = 0; b < 3; b++) {
    const sp = CURTAINS[b === 1 ? 1 : 0];
    const w = dw * (0.46 + b * 0.06);
    const h = dh * (0.58 - b * 0.05);
    const x = dw * (0.16 + b * 0.3) + Math.sin(clock * 0.11 + b * 2.2) * dw * 0.05 - w / 2;
    ctx.globalAlpha = a * (b === 1 ? 0.32 : 0.38);
    ctx.drawImage(sp, x, 0, w, h);
  }
  ctx.restore();
}

/** Whatever weather the day has, over the finished frame. */
function paintWeather(
  ctx: Ctx,
  scene: GenesisScene,
  t: number,
  clock: number,
  dw: number,
  dh: number,
  dpr: number
): void {
  const day = scene.day;
  if (day.type === 'normal') return;
  const m = mistAt(day, t);
  if (m > 0.004) paintMist(ctx, m, dw, dh, clock);
  const r = stormAt(day, t);
  if (r > 0.004) paintRain(ctx, r, dw, dh, clock, dpr, scene.map.seed);
  const a = auroraAt(day, t);
  if (a > 0.004) paintAurora(ctx, a, dw, dh, clock);
}

/* ---------------------------------- sky ---------------------------------- */

/**
 * The light of the day, as one multiply colour and one strength.
 *
 * Multiply is the whole trick: it can only ever take light *away*, so a warm
 * fill pulls the blue out of the afternoon and an indigo fill drops the valley
 * into night, and in both cases the pixels underneath keep their edges. The
 * curve is authored, not physical — the interesting hours are the ones the day
 * changes in, so gold, dusk and the pre-dawn get most of the keyframes.
 *
 * The two ends meet: t=0 and t=24 are the same near-black, which is what lets a
 * world roll over into the next one without a seam.
 */
const SKY: [t: number, r: number, g: number, b: number, a: number, lift: number][] = [
  [0.0, 10, 11, 28, 0.96, 0.0], // midnight — the swap happens in here
  [0.15, 13, 16, 48, 0.93, 0.02],
  [0.55, 35, 48, 94, 0.86, 0.05],
  [1.0, 53, 71, 111, 0.78, 0.07],
  [2.0, 74, 95, 132, 0.62, 0.06], // pre-dawn: the founding house reads clearly
  [3.5, 100, 118, 152, 0.55, 0.07],
  [5.0, 140, 133, 155, 0.43, 0.08], // still the small hours, not yet morning
  [6.0, 214, 163, 128, 0.27, 0.07],
  [7.0, 255, 255, 255, 0.0, 0.0], // full daylight
  [17.5, 255, 255, 255, 0.0, 0.0],
  [18.3, 255, 197, 132, 0.34, 0.1], // golden
  [19.3, 238, 158, 105, 0.44, 0.07],
  [20.3, 140, 134, 196, 0.5, 0.03], // dusk
  [21.5, 90, 95, 168, 0.58, 0.02],
  [22.5, 58, 63, 134, 0.66, 0.0], // night
  [23.2, 38, 45, 99, 0.74, 0.0],
  [23.4, 23, 27, 69, 0.84, 0.0],
  [23.7, 13, 16, 48, 0.93, 0.0], // near-black
  [24.0, 10, 11, 28, 0.96, 0.0],
];

export interface Sky {
  css: string;
  /** Strength of the multiply fill, 0 at noon. */
  a: number;
  /** Strength of the additive horizon wash. */
  lift: number;
  /** 0 = broad daylight, 1 = lamps fully earning their keep. */
  night: number;
  /** Halo strength. Night, but pinched shut across midnight so a world can be
   * swapped for the next one without forty lamps popping out of existence. */
  lamps: number;
}

/**
 * Two rare days bend this curve rather than sitting on top of it, because both
 * of them are *the light changing* and not something in front of it.
 *
 * An eclipse blends the whole keyframe towards a dusk-dark one and back over
 * about forty minutes. Everything downstream follows for free: `night` crosses
 * its threshold, so windows light and lamps get their halos at two in the
 * afternoon, which is the entire charm of it. A storm blends towards a flat
 * grey instead, and deliberately stops just short of that threshold — a wet
 * afternoon is dim, not dark, and nobody lights a lamp for it.
 */
export function skyAt(t: number, day: DayInfo = PLAIN_DAY): Sky {
  const h = t <= 0 ? 0 : t >= 24 ? 24 : t;
  let i = 1;
  while (i < SKY.length - 1 && SKY[i][0] < h) i++;
  const a = SKY[i - 1];
  const b = SKY[i];
  const span = b[0] - a[0] || 1;
  let f = (h - a[0]) / span;
  f = f * f * (3 - 2 * f); // smoothstep: no visible kink at a keyframe
  const mix4 = (k: number) => a[k] + (b[k] - a[k]) * f;
  let cr = mix4(1);
  let cg = mix4(2);
  let cb = mix4(3);
  let alpha = mix4(4);
  let lift = mix4(5);
  /**
   * What the *lamps* think the hour is. Normally the same number as `alpha`,
   * but a storm is allowed to darken the valley a good deal further than it is
   * allowed to convince anybody it is evening.
   */
  let dark = alpha;

  /* ---- the two days that darken the sky itself ------------------------- */
  const dip = (k: number, tr: number, tg: number, tb: number, ta: number, tl: number) => {
    cr += (tr - cr) * k;
    cg += (tg - cg) * k;
    cb += (tb - cb) * k;
    alpha += (ta - alpha) * k;
    lift += (tl - lift) * k;
  };
  const ec = eclipseAt(day, h);
  if (ec > 0) {
    dip(ec * 0.95, 30, 34, 80, 0.68, 0.05);
    dark = alpha;
  }
  const st = stormAt(day, h);
  if (st > 0) {
    dip(st * 0.85, 74, 86, 112, 0.5, 0);
    dark += (0.3 - dark) * st * 0.8;
  }

  const night = Math.max(0, Math.min(1, (dark - 0.16) / 0.42));
  // Last lamp out just before midnight; first hearth lit a few minutes after.
  const gate = h > 23.9 ? Math.max(0, (24 - h) / 0.1) : h < 0.25 ? Math.min(1, h / 0.25) : 1;
  return {
    css: `rgb(${Math.round(cr)},${Math.round(cg)},${Math.round(cb)})`,
    a: alpha,
    lift,
    night,
    lamps: night * gate,
  };
}

/** A soft round halo, baked once, tinted by whoever draws it. */
function glowSprite(scene: GenesisScene): HTMLCanvasElement {
  if (scene.glow) return scene.glow;
  const R = 48;
  const c = document.createElement('canvas');
  c.width = R * 2;
  c.height = R * 2;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(R, R, 0, R, R, R);
  grad.addColorStop(0, 'rgba(255,226,160,1)');
  grad.addColorStop(0.35, 'rgba(255,196,110,0.42)');
  grad.addColorStop(0.72, 'rgba(255,170,90,0.10)');
  grad.addColorStop(1, 'rgba(255,160,80,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, R * 2, R * 2);
  scene.glow = c;
  return c;
}

/* -------------------------------- rendering ------------------------------ */

interface Item {
  depth: number;
  /** World-pixel footprint, used to find the baked sprites standing in front. */
  bx: number;
  by: number;
  bw: number;
  bh: number;
  draw: (c: Ctx) => void;
}

interface Halo {
  x: number;
  y: number;
  r: number;
  a: number;
}

export function renderGenesis(
  ctx: Ctx,
  scene: GenesisScene,
  amb: Ambient,
  snap: WorldSnapshot,
  view: GView,
  clock: number
): void {
  const { zoom, vw, vh } = view;
  // `?perf=2` only: a stopwatch that is lapped at each phase boundary below.
  // Off, `P` is null and every call site is a single null check.
  const P = perfSink;
  let pLast = P ? performance.now() : 0;
  const lap = (
    k: 'setup' | 'veg' | 'bg' | 'roads' | 'build' | 'occl' | 'draw' | 'fx' | 'blit' | 'post' | 'wild'
  ) => {
    const now = performance.now();
    P![k] += now - pLast;
    pLast = now;
  };
  /**
   * Two coordinate systems meet here. The world buffer is in *world* pixels —
   * one unit is one pixel of art. Everything the viewport does, from the blit
   * onwards, is in *device* pixels: the canvas backing store is the CSS box
   * times the display's ratio, so a retina phone is drawn at its real
   * resolution instead of being blown up by the browser afterwards.
   *
   * `scale` is the bridge — device pixels per world pixel. The zoom ladder
   * keeps it a whole number whenever it is at or above 1, which is the whole
   * reason the art stays hard-edged.
   */
  const dpr = view.dpr && view.dpr > 0 ? view.dpr : 1;
  const scale = zoom * dpr;
  const dw = Math.max(1, Math.round(vw * dpr));
  const dh = Math.max(1, Math.round(vh * dpr));
  const bw = Math.max(1, Math.ceil(dw / scale));
  const bh = Math.max(1, Math.ceil(dh / scale));
  const f = scene.frame;
  if (f.width !== bw || f.height !== bh) {
    f.width = bw;
    f.height = bh;
  }
  const g = f.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.imageSmoothingEnabled = false;

  const sky = skyAt(snap.t, scene.day);
  scene.lit = sky.night > 0.5;
  scene.relight = 4;
  if (P) lap('setup');
  syncVeg(scene, snap);
  if (P) lap('veg');
  const wild = tickWildlife(scene, amb, snap, sky, clock); // WILDLIFE
  if (P) lap('wild');

  // Whole world pixels, always: the buffer is drawn at 1 unit = 1 art pixel, so
  // a fractional camera would land sprites and spans off the buffer's own grid
  // and soften them before the blit ever happens. With `scale` whole, a whole
  // world pixel is also a whole device pixel, so this is the device-pixel
  // alignment as well.
  const cx = Math.round(view.cx);
  const cy = Math.round(view.cy);

  /* ---- beyond the map: endless woodland -------------------------------- */
  g.fillStyle = scene.beyond;
  g.fillRect(0, 0, bw, bh);
  const pat = g.createPattern(scene.surround, 'repeat');
  if (pat) {
    try {
      pat.setTransform(new DOMMatrix([1, 0, 0, 1, -cx, -cy]));
      g.fillStyle = pat;
      g.fillRect(0, 0, bw, bh);
    } catch {
      /* setTransform unsupported — the flat fill already covers it. */
    }
  }

  g.drawImage(scene.layer, scene.lx - cx, scene.ly - cy);
  g.translate(-cx, -cy);
  if (P) lap('bg');

  const wx0 = cx - 72;
  // Generous at the top: a mill's sails or a tower's flag can stand 150px above
  // the anchor tile that decides whether the sprite is culled.
  const wy0 = cy - 190;
  const wx1 = cx + bw + 64;
  const wy1 = cy + bh + 64;
  const inView = (x: number, y: number) => x > wx0 && x < wx1 && y > wy0 && y < wy1;

  /* ---- roads, clipped to what has actually been built ------------------
   * The finished ones are already on their own layer, in map order and under
   * everything the per-frame pass is about to lay over them; only the road
   * still growing is stroked here. */
  syncRoads(scene, snap);
  if (scene.roads.n) g.drawImage(scene.roads.c, scene.roads.x, scene.roads.y);
  for (let i = 0; i < scene.map.roads.length; i++) {
    if (scene.roads.baked[i]) continue;
    const road = scene.map.roads[i];
    const frac = snap.roads.get(road.id) ?? 0;
    if (frac <= 0.001) continue;
    const geo = scene.roadGeo.get(road.id)!;
    const pts = cutPolyline(road.pts, geo, frac);
    if (pts.length < 2) continue;
    paintRoad(g, pts, road.kind, road.width, roadStoneSeed(road));
    // A ribboned stake marks the head of an unfinished road.
    if (frac < 0.995) {
      const head = pts[pts.length - 1];
      const hx = isoX(head[0], head[1]);
      const hy = isoY(head[0], head[1]);
      rect(g, hx, hy - 12, 1, 12, PAL.woodLight);
      poly(
        g,
        [
          [hx + 1, hy - 12],
          [hx + 8, hy - 9.5],
          [hx + 1, hy - 7.5],
        ],
        '#63c9a8'
      );
    }
  }

  /* ---- fords ------------------------------------------------------------
   * Terrain, so they are here from midnight whether or not the track has
   * reached them yet — but they have to be laid over the road rather than
   * under it, which is why they are not on the terrain bake. There are only
   * ever a handful, and each is a dozen small polys. */
  for (const fd of scene.map.fords ?? []) {
    drawFord(g, scene.map.river, fd.gx, fd.gy, fd.span);
  }

  /* ---- bridges --------------------------------------------------------- */
  for (const br of scene.map.bridges) {
    const stage = snap.bridges.get(br.id) ?? 0;
    if (!stage) continue;
    drawBridge(g, scene.map.river, br.gx, br.gy, br.span, stage);
  }
  if (P) lap('roads');

  /* ---- the standing wood, the stumps and the dressing, off one layer ----- */
  g.drawImage(scene.veg.c, scene.lx, scene.ly);
  if (P) lap('veg');

  /* ---- one depth-sorted pass over everything that is changing ---------- */
  const items: Item[] = [];
  const halos: Halo[] = [];
  const push = (sp: Sprite, gx: number, gy: number, dy = 0, dx = 0) => {
    const x = isoX(gx, gy);
    const y = isoY(gx, gy);
    if (!inView(x, y)) return;
    const bx = Math.round(x - sp.ox + dx);
    const by = Math.round(y - sp.oy + dy);
    items.push({
      depth: y,
      bx,
      by,
      bw: sp.c.width,
      bh: sp.c.height,
      draw: (c) => c.drawImage(sp.c, bx, by),
    });
  };

  // Only the trees actually under the axe. Everything still standing, and every
  // stump the day has already left, is on the layer blitted a moment ago —
  // `syncVeg` keeps this list as a by-product of putting them there.
  for (const k of scene.veg.felling) {
    const tr = scene.map.trees[k];
    const p = scene.pools[TREE_POOL[tr.kind] ?? 'oak'];
    const sp = p[Math.abs(tr.seed) % p.length];
    // A tree under the axe leans and shivers a couple of pixels — enough to
    // spot from across the valley, cheap enough to be a whole-pixel offset.
    const sway = Math.round(Math.sin(clock * 3.1 + tr.seed) * 2);
    push(sp, tr.gx, tr.gy, 0, sway);
  }

  /* ---- buried treasure -------------------------------------------------- */
  // Mound, dug-out chest or open chest, straight off the snapshot. There are
  // never more than two, so they go through the ordinary item pass and get the
  // ordinary occlusion repair — an open chest half behind a fir is exactly
  // right, because that is where it was buried.
  for (const chest of scene.map.chests ?? []) {
    const state = snap.chests.get(chest.id);
    const sp = chestSprite(scene, chest, state);
    const x = isoX(chest.gx, chest.gy);
    const y = isoY(chest.gx, chest.gy);
    if (!inView(x, y)) continue;
    const bx = Math.round(x - sp.ox);
    const by = Math.round(y - sp.oy);
    const open = state === 'open';
    items.push({
      depth: y,
      bx,
      by,
      bw: sp.c.width,
      bh: sp.c.height,
      draw: (c) => {
        c.drawImage(sp.c, bx, by);
        if (open) drawChestGlint(c, x, y, clock);
      },
    });
    if (open && sky.lamps > 0.02) {
      halos.push({ x, y: y - 10, r: 22, a: sky.lamps * 0.5 });
    }
  }

  // Site dressing itself is baked; what is left of it here is the light it
  // throws, which is a screen-space pass and cannot be.
  let pi = 0;
  for (const site of scene.map.sites) {
    for (const p of site.props) {
      const slot = scene.veg.props[pi++];
      if (slot < 0 || !scene.veg.on[slot]) continue;
      if (sky.lamps > 0.02 && (p.kind === 'lamp' || p.kind === 'campfire')) {
        const x = isoX(p.gx, p.gy);
        const y = isoY(p.gx, p.gy);
        if (inView(x, y)) {
          const lamp = p.kind === 'lamp';
          halos.push({
            x,
            y: y - (lamp ? 14 : 2),
            r: lamp ? 26 : 30,
            a: sky.lamps * (lamp ? 0.72 : 0.85),
          });
        }
      }
    }
    for (const b of site.buildings) {
      const st = snap.buildings.get(b.id);
      if (!st || st.status === 'unplanned') continue;
      const x = isoX(b.gx, b.gy);
      const y = isoY(b.gx, b.gy);
      if (!inView(x, y)) continue;
      const sp = structFor(scene, b, st.progress);
      const bx = Math.round(x - sp.ox);
      const by = Math.round(y - sp.oy);
      items.push({
        depth: y,
        bx,
        by,
        bw: sp.c.width,
        bh: sp.c.height,
        draw: (c) => c.drawImage(sp.c, bx, by),
      });
      if (sky.lamps > 0.02 && st.status === 'done') {
        halos.push({
          x,
          y: y - sp.oy * 0.45,
          r: 18 + b.w * 0.22,
          a: sky.lamps * 0.4,
        });
      }
      // Something landmark-sized going up gets a crane in its yard, on the side
      // the site is: that is where the materials come from and where the ground
      // is already trampled. It goes away with the last course of the roof.
      if (b.w >= 44 && st.progress > 0.12 && st.progress < 0.985) {
        const cs = propSprite(scene, 'crane', b.seed, b.accent);
        if (cs) {
          let ux = site.gx - b.gx;
          let uy = site.gy - b.gy;
          const d = Math.hypot(ux, uy);
          if (d < 0.5) {
            ux = 0.7071;
            uy = 0.7071;
          } else {
            ux /= d;
            uy /= d;
          }
          const kgx = b.gx + ux * 2.1;
          const kgy = b.gy + uy * 2.1;
          const kx = isoX(kgx, kgy);
          const ky = isoY(kgx, kgy);
          if (inView(kx, ky)) {
            const cbx = Math.round(kx - cs.ox);
            const cby = Math.round(ky - cs.oy);
            const hx = Math.round(kx);
            const hy = Math.round(ky);
            items.push({
              // The hook and its load stay inside the mast sprite's own box,
              // so one rectangle covers the whole crane for occlusion repair.
              depth: ky,
              bx: cbx,
              by: cby,
              bw: cs.c.width,
              bh: cs.c.height,
              draw: (c) => {
                c.drawImage(cs.c, cbx, cby);
                drawCraneLoad(c, hx, hy, clock);
              },
            });
          }
        }
      }
    }
  }

  /* ---- FESTIVAL: bunting between the roofs ----------------------------- */
  // Deliberately *not* on the baked layer. A string is tied to two roofs and
  // has to hang in front of both of them; the roofs are per-frame items, so the
  // string has to be one too, at a depth just past the nearer of its anchors.
  const feast = festivalOn(scene, snap);
  if (feast) {
    for (const bt of buntingFor(scene)) {
      if (!inView(bt.x, bt.y)) continue;
      const bx = Math.round(bt.x - bt.sprite.ox);
      const by = Math.round(bt.y - bt.sprite.oy);
      items.push({
        depth: bt.depth,
        bx,
        by,
        bw: bt.sprite.c.width,
        bh: bt.sprite.c.height,
        draw: (c) => c.drawImage(bt.sprite.c, bx, by),
      });
    }
  }

  // Everything from here on moves every frame. The occlusion repair below runs
  // over these first, so that if it ever hits its budget it is the scenery that
  // goes unrepaired, never the crowd.
  const moversFrom = items.length;

  /* ---- FESTIVAL: the fire ----------------------------------------------- */
  // A mover, because it is the one thing in the valley that is never the same
  // shape twice, and the biggest light source the day ever has.
  if (feast && scene.fire) {
    const fx = isoX(scene.fire[0], scene.fire[1]);
    const fy = isoY(scene.fire[0], scene.fire[1]);
    if (inView(fx, fy)) {
      const sp = cached(scene, 'bonfire', () => buildBonfire(scene.map.seed));
      const bx = Math.round(fx - sp.ox);
      const by = Math.round(fy - sp.oy);
      items.push({
        depth: fy,
        bx,
        by,
        bw: sp.c.width,
        bh: sp.c.height,
        draw: (c) => {
          c.drawImage(sp.c, bx, by);
          drawBonfire(c, fx, fy, clock);
        },
      });
      // Bright enough to be the thing you look at, dim enough that the people
      // standing in it are still people.
      const flick = 0.86 + Math.sin(clock * 5.3) * 0.06 + Math.sin(clock * 2.1) * 0.05;
      halos.push({ x: fx, y: fy - 6, r: 38, a: Math.max(0.3, sky.lamps) * 0.55 * flick });
    }
  }

  for (const w of amb.wheels) {
    if (!inView(w.x, w.y)) continue;
    const wx = Math.round(w.x);
    const wy = Math.round(w.y);
    items.push({
      depth: w.y + 6,
      bx: wx - 9,
      by: wy - 9,
      bw: 18,
      bh: 18,
      draw: (c) => drawWheel(c, wx, wy, clock),
    });
  }

  for (const bot of amb.bots) {
    const x = isoX(bot.gx, bot.gy);
    const y = isoY(bot.gx, bot.gy);
    if (!inView(x, y)) continue;
    const px = Math.round(x);
    const py = Math.round(y);
    const { color, faceRight, action, phase } = bot;
    items.push({
      depth: y + 1,
      bx: px - 7,
      by: py - 20,
      bw: 15,
      bh: 22,
      draw: (c) => {
        drawBot(c, px, py, color, faceRight, action, phase);
        if (action === 'work' && Math.sin(phase * 11) > 0.85) {
          c.fillStyle = '#fff3c4';
          const s = faceRight ? 6 : -7;
          c.fillRect(px + s, py - 12, 1, 1);
          c.fillRect(px + s + 2, py - 14, 1, 1);
          c.fillRect(px + s - 1, py - 15, 1, 1);
        }
      },
    });
  }

  for (const d of amb.diggers) {
    const x = isoX(d.gx, d.gy);
    const y = isoY(d.gx, d.gy);
    if (!inView(x, y)) continue;
    const px = Math.round(x);
    const py = Math.round(y);
    const { color, faceRight, action, phase } = d;
    items.push({
      depth: y + 1,
      bx: px - 7,
      by: py - 20,
      bw: 15,
      bh: 22,
      draw: (c) => {
        drawBot(c, px, py, color, faceRight, action, phase);
        // Earth coming off the spade, on the same beat as a hammer spark.
        if (action === 'work' && Math.sin(phase * 8) > 0.8) {
          c.fillStyle = '#b98b5f';
          const s = faceRight ? 6 : -7;
          c.fillRect(px + s, py - 9, 1, 1);
          c.fillRect(px + s + 1, py - 11, 1, 1);
        }
      },
    });
  }

  for (const w of amb.walkers) {
    const x = isoX(w.gx, w.gy);
    const y = isoY(w.gx, w.gy);
    if (!inView(x, y)) continue;
    const px = Math.round(x);
    const py = Math.round(y);
    const { color, faceRight, phase, cargo } = w;
    if (w.cart) {
      // A cart is bed, load, wheels and carter: nearly three times a walker
      // wide, and the occlusion rect has to say so or it drives through trunks.
      items.push({
        depth: y + 1,
        bx: px - 18,
        by: py - 20,
        bw: 36,
        bh: 22,
        draw: (c) => drawCart(c, px, py, color, faceRight, phase, cargo),
      });
      continue;
    }
    items.push({
      depth: y + 1,
      bx: px - 7,
      by: py - 20,
      bw: 15,
      bh: 22,
      draw: (c) => drawBot(c, px, py, color, faceRight, 'walk', phase),
    });
  }

  if (P) lap('build');

  // WILDLIFE — ground-dwellers, inside the repair pass with the rest of the crowd.
  pushWildlife(scene, wild, items, wx0, wy0, wx1, wy1);
  if (P) lap('wild');

  /* ---- occlusion repair ------------------------------------------------
   * Everything above was drawn *after* the whole standing wood, so a mover
   * that should be hidden behind a nearer trunk would walk over it. Redraw the
   * few baked sprites that stand in front of a mover, at the exact pixel the
   * bake used, so the patch is invisible. Below 1× the error is a pixel or two
   * and the query is not worth its own cost. */
  if (zoom >= 0.75) {
    const veg = scene.veg;
    const n0 = items.length;
    const need = new Set<number>();
    /** @returns false once the repair budget is spent. */
    const repairsFor = (it: Item): boolean => {
      const cx0 = Math.floor(it.bx / VCELL);
      const cx1 = Math.floor((it.bx + it.bw) / VCELL);
      const cy0 = Math.floor(it.by / VCELL);
      const cy1 = Math.floor((it.by + it.bh) / VCELL);
      for (let gy = cy0; gy <= cy1 + 1; gy++) {
        for (let gx = cx0; gx <= cx1; gx++) {
          const arr = veg.grid.get(vkey(gx, gy));
          if (!arr) continue;
          // Cell lists ascend with item index, and item index ascends with
          // depth, so walking a cell backwards reaches the sprites in front of
          // this one first and can stop dead at the first one behind it. In a
          // dense wood that is the difference between reading a handful of
          // entries per cell and reading all of them.
          for (let k = arr.length - 1; k >= 0; k--) {
            const idx = arr[k];
            const s = veg.items[idx];
            if (s.depth <= it.depth) break;
            if (!veg.on[idx] || need.has(idx)) continue;
            if (s.bx > it.bx + it.bw || s.bx + s.bw < it.bx) continue;
            if (s.by > it.by + it.bh || s.by + s.bh < it.by) continue;
            need.add(idx);
            if (need.size >= REPAIR_CAP) return false;
          }
        }
      }
      return true;
    };
    let room = true;
    for (let e = moversFrom; e < n0 && room; e++) room = repairsFor(items[e]);
    for (let e = 0; e < moversFrom && room; e++) room = repairsFor(items[e]);
    need.forEach((idx) => {
      const s = veg.items[idx];
      items.push({
        depth: s.depth,
        bx: s.bx,
        by: s.by,
        bw: s.bw,
        bh: s.bh,
        draw: (c) => paintVeg(c, s),
      });
    });
    if (P) P.repairs += need.size;
  }
  if (P) lap('occl');

  if (P) {
    P.frames += 1;
    P.items += items.length;
    P.halos += halos.length;
  }
  items.sort((a, b) => a.depth - b.depth);
  for (const it of items) it.draw(g);
  if (P) lap('draw');

  drawSparks(g, amb.sparks, wx0, wy0, wx1, wy1);
  if (P) lap('fx');
  drawWildlifeAir(g, scene, wild, wx0, wy0, wx1, wy1); // WILDLIFE — above the canopy, over the sparks
  if (P) lap('wild');
  drawSmoke(g, amb.smoke, wx0, wy0, wx1, wy1, sky.night);
  if (P) lap('fx');

  /* ---- blit the world buffer to the viewport --------------------------- */
  // From here down the viewport is measured in device pixels; no transform is
  // set on `ctx`, so every coordinate below is a real pixel of the panel.
  g.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, dw, dh);
  ctx.drawImage(f, 0, 0, bw, bh, 0, 0, bw * scale, bh * scale);
  if (P) lap('blit');

  /* ---- the sky, over the finished frame -------------------------------- */
  // Deliberately *not* in the world buffer: this is one screen-sized fill
  // rather than one world-sized one, and the crisp pixels underneath are
  // already blitted and safe.
  if (sky.a > 0.002) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = sky.a;
    ctx.fillStyle = sky.css;
    ctx.fillRect(0, 0, dw, dh);
    ctx.restore();
  }
  if (sky.lift > 0.004) {
    // A wash of low sun (or the first grey of the morning) off the horizon.
    const cool = snap.t < 12;
    const grad = ctx.createLinearGradient(0, 0, 0, dh);
    grad.addColorStop(0, cool ? 'rgba(126,158,214,1)' : 'rgba(255,180,99,1)');
    grad.addColorStop(1, cool ? 'rgba(126,158,214,0)' : 'rgba(255,180,99,0)');
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = sky.lift;
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, dw, dh);
    ctx.restore();
  }
  if (halos.length && sky.lamps > 0.02) {
    const sp = glowSprite(scene);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    for (const h of halos) {
      // Soft by design — these are the one thing that *wants* smoothing, so
      // drawing them larger at device resolution only makes them smoother.
      const sx = (h.x - cx) * scale;
      const sy = (h.y - cy) * scale;
      const r = h.r * scale;
      if (sx + r < 0 || sx - r > dw || sy + r < 0 || sy - r > dh) continue;
      ctx.globalAlpha = h.a;
      ctx.drawImage(sp, sx - r, sy - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  if (P) lap('post');

  // WILDLIFE — after the sky, so the night fill cannot put the fireflies out.
  drawFireflies(ctx, wild, cx, cy, scale, dw, dh);
  if (P) lap('wild');

  /* ---- and whatever weather this rare day has, last of all -------------
     (after the fireflies: rain and mist may veil them, the aurora hangs
     above them) */
  paintWeather(ctx, scene, snap.t, clock, dw, dh, dpr);
  if (P) lap('post');
}

/**
 * A ford: what a track does instead of building a bridge.
 *
 * There are no stages, because there is nothing to build — the whole thing is
 * terrain plus footfall, and it looks the same at midnight as it does at noon.
 * Three parts, in order: the bed comes up so the water goes pale and slack; the
 * banks are trodden out wide either side where carts and feet turn in; and a
 * line of flat stones goes across for anyone who would rather stay dry.
 *
 * Drawn AFTER the roads, so the track's own surface passes underneath and reads
 * as a wet bed running on through the shallows rather than as a road that stops
 * at the water. Exported for the catalog.
 */
export function drawFord(ctx: Ctx, river: Vec2[], gx: number, gy: number, span: number): void {
  // Orient across the local current, exactly as a bridge deck is oriented.
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i + 1 < river.length; i++) {
    const d = segDist(gx, gy, river[i], river[i + 1]);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  const tx = river[bi + 1][0] - river[bi][0];
  const ty = river[bi + 1][1] - river[bi][1];
  const tl = Math.hypot(tx, ty) || 1;
  const nx = -ty / tl;
  const ny = tx / tl;
  const half = span / 2;
  /** how far up- and downstream the slack water reads */
  const depth = 1.5;
  /** `a` runs across the water along the track, `b` runs with the current */
  const at = (a: number, b: number): Pt => {
    const px = gx + nx * a + (tx / tl) * b;
    const py = gy + ny * a + (ty / tl) * b;
    return [isoX(px, py), isoY(px, py)];
  };
  const quad = (a0: number, a1: number, b: number, col: string) =>
    poly(ctx, [at(a0, -b), at(a1, -b), at(a1, b), at(a0, b)], col);

  // 1. the shallows — pale, and paler still down the middle where the gravel
  //    bar is highest. Translucent so the track underneath still shows through.
  ctx.globalAlpha = 0.55;
  quad(-half - 1.1, half + 1.1, depth, PAL.waterLight);
  ctx.globalAlpha = 0.4;
  quad(-half - 0.7, half + 0.7, depth * 0.55, shade(PAL.waterLight, 0.26));
  ctx.globalAlpha = 1;

  // 2. the trodden banks either side, where the ground is churned to sand
  for (const side of [-1, 1]) {
    poly(
      ctx,
      [
        at(side * (half - 0.2), -depth * 1.15),
        at(side * (half + 1.15), -depth * 0.72),
        at(side * (half + 1.15), depth * 0.72),
        at(side * (half - 0.2), depth * 1.15),
      ],
      PAL.sand
    );
  }

  // 3. the stones, and the water piling up on the upstream shoulder of each.
  //    Seeded off the crossing itself, so the jitter never crawls frame to frame.
  const rr = mulberry32(((Math.round(gx * 733 + gy * 1409) >>> 0) ^ 0xf0d0dabc) >>> 0);
  const N = Math.max(4, Math.round(span * 2.2));
  for (let k = 0; k <= N; k++) {
    const a = -half * 0.92 + (k / N) * half * 1.84;
    const b = (rr() - 0.5) * 0.5;
    const [sx, sy] = at(a, b);
    const w = 3 + Math.round(rr() * 2);
    poly(
      ctx,
      [
        [sx - w, sy],
        [sx, sy - w * 0.5],
        [sx + w, sy],
        [sx, sy + w * 0.5],
      ],
      PAL.stoneDark
    );
    poly(
      ctx,
      [
        [sx - w + 1, sy - 1],
        [sx, sy - w * 0.5 - 1],
        [sx + w - 1, sy - 1],
        [sx, sy + w * 0.5 - 1],
      ],
      PAL.stone
    );
    // foam on the upstream side only — one tick, one pixel high
    const [fx, fy] = at(a, b - 0.42);
    rect(ctx, fx - 2, fy - 1, 2 + Math.round(rr() * 3), 1, PAL.waterFoam);
  }
}

/** A bridge at one of its three build stages. Exported for the catalog. */
export function drawBridge(
  ctx: Ctx,
  river: Vec2[],
  gx: number,
  gy: number,
  span: number,
  stage: 1 | 2 | 3
): void {
  // Orient the deck across the local current, exactly like the Vale does.
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i + 1 < river.length; i++) {
    const d = segDist(gx, gy, river[i], river[i + 1]);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  const tx = river[bi + 1][0] - river[bi][0];
  const ty = river[bi + 1][1] - river[bi][1];
  const tl = Math.hypot(tx, ty) || 1;
  const nx = -ty / tl;
  const ny = tx / tl;
  const half = span / 2;
  const depth = 1.15;
  const corner = (a: number, b: number): Pt => {
    const px = gx + nx * a + (tx / tl) * b;
    const py = gy + ny * a + (ty / tl) * b;
    return [isoX(px, py), isoY(px, py)];
  };

  // Stage 1 — pilings driven into the ford.
  for (let k = -half; k <= half + 0.01; k += 1.1) {
    for (const side of [-1, 1]) {
      const p = corner(Math.min(k, half), side * depth);
      rect(ctx, p[0] - 1, p[1] - 10, 2, 12, PAL.woodDark);
      rect(ctx, p[0] - 1, p[1] - 11, 2, 1, PAL.wood);
    }
  }

  if (stage >= 2) {
    poly(
      ctx,
      [corner(-half, -depth), corner(half, -depth), corner(half, depth), corner(-half, depth)],
      PAL.woodDark
    );
    poly(
      ctx,
      [
        corner(-half, -depth + 0.25),
        corner(half, -depth + 0.25),
        corner(half, depth - 0.25),
        corner(-half, depth - 0.25),
      ],
      PAL.wood
    );
    for (let k = -half; k < half; k += 0.9) {
      poly(
        ctx,
        [
          corner(k, -depth + 0.3),
          corner(k + 0.28, -depth + 0.3),
          corner(k + 0.28, depth - 0.3),
          corner(k, depth - 0.3),
        ],
        PAL.woodLight
      );
    }
  }

  if (stage >= 3) {
    for (const side of [-1, 1]) {
      const a = corner(-half, side * depth);
      const b = corner(half, side * depth);
      poly(
        ctx,
        [
          [a[0], a[1] - 5],
          [b[0], b[1] - 5],
          [b[0], b[1] - 3.5],
          [a[0], a[1] - 3.5],
        ],
        PAL.woodLight
      );
      for (let k = -half; k <= half; k += 1.6) {
        const p = corner(k, side * depth);
        rect(ctx, p[0], p[1] - 5, 1, 5, PAL.woodDark);
      }
    }
  }
}

/** The pixels thrown up when a lid comes off. Over everything, like the smoke. */
function drawSparks(ctx: Ctx, sparks: Spark[], wx0: number, wy0: number, wx1: number, wy1: number): void {
  for (const s of sparks) {
    const px = Math.round(s.x);
    const py = Math.round(s.y);
    if (px < wx0 || px > wx1 || py < wy0 || py > wy1) continue;
    ctx.globalAlpha = Math.max(0, 1 - s.age / 1.5);
    ctx.fillStyle = s.color;
    ctx.fillRect(px, py, 1, 1);
    ctx.globalAlpha = 1;
  }
}

function drawSmoke(
  ctx: Ctx,
  smoke: Smoke[],
  wx0: number,
  wy0: number,
  wx1: number,
  wy1: number,
  night = 0
): void {
  // Smoke is the one thing the multiply pass cannot dim convincingly — white
  // over a dark valley still reads as white — so it thins out after dark.
  const dim = 0.8 * (1 - night * 0.72);
  for (const p of smoke) {
    const a = p.age;
    const r = 2 + a * 2.2;
    const px = Math.round(p.x + Math.sin(a * 1.7 + p.drift) * 3 + a * 2.2);
    const py = Math.round(p.y - a * 9);
    if (px + r < wx0 || px - r > wx1 || py + r < wy0 || py - r > wy1) continue;
    ctx.globalAlpha = Math.max(0, 1 - a / 3.6) * dim;
    ctx.fillStyle = a < 1 ? '#ffffff' : a < 2.4 ? '#f1ece2' : '#e4e0da';
    const ri = Math.round(r);
    for (let k = -ri; k <= ri; k++) {
      const w = Math.round(Math.sqrt(Math.max(0, r * r - k * k)) * 2);
      if (w > 0) ctx.fillRect(px - Math.round(w / 2), py + k, w, 1);
    }
    ctx.globalAlpha = 1;
  }
}

/* ========================================================================== *
 *                                  WILDLIFE                                  *
 * -------------------------------------------------------------------------- *
 * The half of the valley that nobody planned: birds out of a tree that is
 * coming down, fireflies over the wetland after dark, deer at the treeline in
 * the hour either side of the light, a flock that actually moves, fish in the
 * river and a dog behind a cart.
 *
 * It is deliberately a *separate* system from the ambient crowd above:
 *
 *  - State hangs off a WeakMap keyed by the scene rather than off any of the
 *    existing structures, so nothing in `GenesisScene`, `Ambient` or the
 *    snapshot signature has to know it exists. A new world means a new scene
 *    means new wildlife, and yesterday's is collected with it.
 *  - It has no signature of its own to re-derive from. `tickWildlife` runs off
 *    the snapshot and the sky every frame, and takes its `dt` from the
 *    renderer's own clock — which only advances while the world is running, so
 *    a paused or reduced-motion visitor gets a frozen tableau for free: deer
 *    stopped mid-graze, fireflies lit but still, no bird ever startled.
 *  - All randomness comes off one dedicated mulberry32 stream seeded 7777, and
 *    `resetWildlife` re-seeds it from the same call site `resetAmbient` uses,
 *    so a scrub backwards is as reproducible here as it is there.
 *
 * Drawing splits three ways. Ground-dwellers (deer, horses, cattle, the fox,
 * the flock, shepherd, dog, ducks, fish, ripples) are pushed as ordinary
 * depth-sorted `Item`s *after* the crowd, so they are inside the
 * occlusion-repair pass and go behind the trunks they should. Birds *in flight*
 * skip repair entirely and are drawn straight over the finished item pass: they
 * are above the canopy by the second frame of a burst, so there is nothing in
 * the valley that can legitimately stand in front of one. Fireflies are drawn
 * last of all, on the *viewport* after the sky multiply — a firefly that the
 * night fill could dim would not be a firefly.
 *
 * A bird that has *landed* is the one exception to that rule, and deliberately.
 * It sits on a roof ridge for a minute at a time, which is long enough that a
 * fir standing in front of the house would be a mistake somebody notices — so a
 * perched bird goes through the item pass like everything else, at its
 * building's own depth plus a hair. That puts it over its own roof (the
 * building is an item too, half a pixel behind it, so there is nothing to
 * z-fight) and under any trunk that is genuinely nearer, which the repair pass
 * then paints back.
 * ========================================================================== */

// A local import block, so this section can be lifted or merged in one piece.
import {
  STORY,
  buildBird,
  buildCattle,
  buildDeer,
  buildDog,
  buildDuck,
  buildFox,
  buildGrazingSheep,
  buildHorse,
  buildPerchedBird,
  drawFishJump,
  drawRipple,
} from '../vale/art';

interface WBird {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  ph: number;
}
interface WFly {
  bx: number;
  by: number;
  x: number;
  y: number;
  r: number;
  ph: number;
  sp: number;
  a: number;
  b: number;
  c: number;
}
interface WDeer {
  gx: number;
  gy: number;
  tx: number;
  ty: number;
  /** 0 graze, 1 amble, 2 bolt. */
  st: 0 | 1 | 2;
  timer: number;
  headT: number;
  head: 0 | 1;
  face: boolean;
  vx: number;
  vy: number;
  seed: number;
}
interface WSheep {
  gx: number;
  gy: number;
  tx: number;
  ty: number;
  timer: number;
  graze: boolean;
  face: boolean;
  seed: number;
}
interface WHerder {
  gx: number;
  gy: number;
  tx: number;
  ty: number;
  timer: number;
  phase: number;
  walking: boolean;
  face: boolean;
  color: string;
}
interface WDog {
  w: Walker;
  /** Tiles of road between the cart and the dog. */
  back: number;
  want: number;
  timer: number;
  gx: number;
  gy: number;
  face: boolean;
  phase: number;
  pose: 0 | 1;
}
/**
 * A bird that has landed on a finished roof. `u` is where along the ridge it
 * is sitting, 0..1; a hop is a step in `u`, which keeps it on the ridge line
 * whatever the roof's pitch is.
 */
interface WPerch {
  roof: WRoof;
  u: number;
  face: boolean;
  /** Seconds left before it goes of its own accord. */
  life: number;
  /** Seconds to the next hop along the ridge. */
  hop: number;
  /** Wing phase, so the frame it leaves on is not always the same one. */
  ph: number;
}
interface WHorse {
  gx: number;
  gy: number;
  tx: number;
  ty: number;
  timer: number;
  headT: number;
  head: 0 | 1;
  face: boolean;
  seed: number;
}
interface WCow {
  gx: number;
  gy: number;
  tx: number;
  ty: number;
  timer: number;
  graze: boolean;
  face: boolean;
  seed: number;
}
/** One fox, one night, one field edge. `k` is how far along the edge it is. */
interface WFox {
  gx: number;
  gy: number;
  k: number;
  /** Tiles per second along the edge; sign is the direction of travel. */
  sp: number;
  /** 0 stopped and listening, 1 trotting. */
  st: 0 | 1;
  timer: number;
  face: boolean;
  phase: number;
  pose: 0 | 1;
}
interface WDuck {
  bx: number;
  by: number;
  gx: number;
  gy: number;
  r: number;
  ph: number;
  sp: number;
  a: number;
  b: number;
  face: boolean;
}
interface WFish {
  x: number;
  y: number;
  base: number;
  vx: number;
  vy: number;
}
interface WRing {
  x: number;
  y: number;
  age: number;
}

/** A gap in the wood big enough for a deer to stand in, and the way home. */
interface WSpot {
  gx: number;
  gy: number;
  /** Unit vector pointing back into the trees. */
  ix: number;
  iy: number;
}

/**
 * One roof a bird can sit on: the building it belongs to, and the two ends of
 * its ridge in world pixels *relative to the building's ground anchor*. The
 * anchor is a map fact, the ridge is a pure function of the building spec, and
 * neither moves during a day — so the whole thing is cache, and all the tick
 * has to ask the snapshot is whether the house is finished yet.
 */
interface WRoof {
  bid: string;
  gx: number;
  gy: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** A patch of open green by the biggest town, and the run of fence that says
 * somebody means to keep something in it. */
interface WPaddock {
  gx: number;
  gy: number;
  fence: { gx: number; gy: number; kind: 'fenceL' | 'fenceR' }[];
}

/** Everything derived from the *map*, which a scrub cannot change. Built once
 * per scene and kept across every reset. */
interface WCache {
  wet: GenesisMap['chunks'];
  spots: WSpot[];
  flock: Vec2 | null;
  rgeo: RoadGeo | null;
  /** Every ridge in the valley a bird could land on, in map order. */
  roofs: WRoof[];
  paddock: WPaddock | null;
  /** Middle of a farm chunk with nothing in it — where the cattle stand. */
  pasture: Vec2 | null;
  /** The fox's beat: two ends of one field edge, in tiles. */
  edge: [Vec2, Vec2] | null;
  /** The lake the ducks are on, if the valley has one worth the trouble. */
  lake: LakeSpec | null;
  /** Is this valley's one night a fox night, and what hour does it start? */
  foxNight: boolean;
  foxAt: number;
}

interface Wildlife {
  ready: boolean;
  rng: () => number;
  /** The renderer's clock at the last tick; -1 until the first one. */
  clock: number;
  cache: WCache;
  birds: WBird[];
  perch: WPerch[];
  flies: WFly[];
  deer: WDeer[];
  sheep: WSheep[];
  horses: WHorse[];
  cows: WCow[];
  fox: WFox | null;
  ducks: WDuck[];
  herder: WHerder | null;
  dogs: WDog[];
  fish: WFish[];
  rings: WRing[];
  /** Tree ids already accounted for, so a *transition* into felling is news. */
  seen: Set<string>;
  treeSize: number;
  /** How much of a firefly there is to see, 0..1. */
  vis: number;
  deerCool: number;
  fishT: number;
  dogT: number;
  /** Seconds to the next attempt at landing a bird on a roof. */
  perchT: number;
  /** Seconds to the next look round for anybody walking under a perched bird. */
  perchScan: number;
  /** Is this one of the nights a fox comes out at all? Rolled once, at reset. */
  foxNight: boolean;
  /** The hour it appears, and whether tonight's has already been and gone. */
  foxAt: number;
  foxDone: boolean;
  /**
   * True only inside `resetWildlife`'s settle loop. The settle exists so that a
   * paused or reduced-motion arrival opens on a lived-in valley — but a fox is
   * a *sighting*, and one frozen mid-trot in a still frame would be a fixture.
   * So the fox, alone, declines to be settled into existence.
   */
  settling: boolean;
}

const WILD = new WeakMap<GenesisScene, Wildlife>();

/** The wildlife stream. Seeded once here and nowhere else. */
const WILD_SEED = 7777;
const FLY_MIN = 8;
const FLY_MAX = 15;
/** Dawn and dusk, the two hours a deer will stand in the open. */
const DEER_WINDOWS: [number, number][] = [
  [5.4, 8.0],
  [18.4, 20.6],
];
/** Tiles between a deer and a person before the deer decides otherwise. */
const DEER_SPOOK = 3;

/* -------------------------- population ceilings --------------------------
 * Every one of these is a hard cap, not a target. The wildlife budget is a
 * third of a millisecond a frame and the valley is meant to feel *noticed*,
 * not stocked: two horses in one paddock read as a farm, eight read as a fair.
 */
const PERCH_MAX = 3;
const HORSE_MAX = 2;
const COW_MAX = 3;
const DUCK_MAX = 4;
/** Where along a ridge a bird will sit — clear of the banner at one gable end
 * and the chimney at the other. */
const PERCH_U0 = 0.3;
const PERCH_U1 = 0.7;
/** Tiles between a perched bird and somebody walking under it. */
const PERCH_SPOOK = 1.9;
/** …and the odds it minds, per third-of-a-second look round. Low on purpose:
 * a bird that leaves the first time anyone walks past is a bird nobody ever
 * sees sitting down. */
const PERCH_FLUSH = 0.07;
/** The hours a village bird is up and about; outside them they are roosting. */
const PERCH_FROM = 5.8;
const PERCH_TO = 20.4;
/** The fox's window. It is never out before the first, never after the second. */
const FOX_FROM = 22.0;
const FOX_TO = 23.5;
/** …and only on one night in three. */
const FOX_CHANCE = 1 / 3;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ------------------------------ map cache -------------------------------- */

/**
 * The two things that need the whole map read: where the wetland is, and where
 * the wood has an edge. Both are answered off a coarse tree-density grid, so
 * finding a treeline costs a few hundred hash lookups instead of a few hundred
 * thousand distance tests.
 */
function wildCache(scene: GenesisScene): WCache {
  const map = scene.map;
  const wet = map.chunks.filter((c) => c.biome === 'wetland');

  const dens = new Map<number, number>();
  const dkey = (cx: number, cy: number) => (cx + 1024) * 4096 + (cy + 1024);
  const cellOf = (g: number) => Math.floor(g / 3);
  /** The same grid, holding the trees themselves. Local to this function, so it
   * is collected the moment the cache is built — a treeline is answered by the
   * counts above, but a paddock needs to know a horse is not standing *in* an
   * oak, and three-tile granularity is far too coarse to say so. */
  const cellTrees = new Map<number, TreeSpec[]>();
  for (const tr of map.trees) {
    const k = dkey(cellOf(tr.gx), cellOf(tr.gy));
    dens.set(k, (dens.get(k) ?? 0) + 1);
    const arr = cellTrees.get(k);
    if (arr) arr.push(tr);
    else cellTrees.set(k, [tr]);
  }
  /** Is there a trunk within `r` tiles of here? */
  const treeNear = (gx: number, gy: number, r: number): boolean => {
    const cx = cellOf(gx);
    const cy = cellOf(gy);
    const rad = Math.ceil(r / 3);
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const arr = cellTrees.get(dkey(cx + dx, cy + dy));
        if (!arr) continue;
        for (const tr of arr) if (Math.hypot(tr.gx - gx, tr.gy - gy) < r) return true;
      }
    }
    return false;
  };
  /** Trees in the (2*rad+1)² block of 3-tile cells around a point. */
  const around = (gx: number, gy: number, rad: number) => {
    const cx = cellOf(gx);
    const cy = cellOf(gy);
    let n = 0;
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) n += dens.get(dkey(cx + dx, cy + dy)) ?? 0;
    }
    return n;
  };

  const spots: WSpot[] = [];
  const rr = mulberry32((map.seed ^ 0x5eed17) >>> 0);
  const dirs: Vec2[] = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  const C = map.content;
  for (let a = 0; a < 300 && spots.length < 4 && map.trees.length; a++) {
    const tr = map.trees[Math.floor(rr() * map.trees.length)];
    if (!tr || around(tr.gx, tr.gy, 1) < 9) continue; // must be properly in the wood
    const d = dirs[Math.floor(rr() * dirs.length)];
    const L = Math.hypot(d[0], d[1]) || 1;
    const ox = d[0] / L;
    const oy = d[1] / L;
    const gx = tr.gx + ox * 5;
    const gy = tr.gy + oy * 5;
    if (around(gx, gy, 0) > 0) continue; // …and the far side properly open
    if (around(gx + ox * 2, gy + oy * 2, 0) > 0) continue;
    const u = gx - gy;
    const v = gx + gy;
    if (u < C.u0 + 5 || u > C.u1 - 5 || v < C.v0 + 5 || v > C.v1 - 5) continue;
    let near = false;
    for (const s of map.sites) {
      if (Math.hypot(gx - s.gx, gy - s.gy) < s.radius + 6) near = true;
    }
    if (near) continue;
    spots.push({ gx, gy, ix: -ox, iy: -oy });
  }

  /* ---- the biggest huddle of scattered sheep on the map ----------------- */
  let flock: Vec2 | null = null;
  const cells = new Map<number, { n: number; x: number; y: number }>();
  for (const p of map.scatter) {
    if (p.kind !== 'sheep') continue;
    const k = dkey(Math.floor(p.gx / 5), Math.floor(p.gy / 5));
    const e = cells.get(k);
    if (e) {
      e.n++;
      e.x += p.gx;
      e.y += p.gy;
    } else cells.set(k, { n: 1, x: p.gx, y: p.gy });
  }
  let best: { n: number; x: number; y: number } | null = null;
  cells.forEach((e) => {
    if (!best || e.n > best.n) best = e;
  });
  const pick = best as { n: number; x: number; y: number } | null;
  if (pick && pick.n >= 2) flock = [pick.x / pick.n, pick.y / pick.n];

  /* ---- open ground ------------------------------------------------------
   * The one predicate the paddock, the pasture and the fox's beat all want:
   * inside the framed valley, off the roads and the water, out of everybody's
   * town, and with no more wood on it than the caller can live with. */
  const lakes = map.lakes ?? [];
  const clearAt = (gx: number, gy: number, pad: number, clear: number): boolean => {
    const u = gx - gy;
    const v = gx + gy;
    if (u < C.u0 + 3 || u > C.u1 - 3 || v < C.v0 + 3 || v > C.v1 - 3) return false;
    if (treeNear(gx, gy, clear)) return false;
    for (const s of map.sites) {
      if (Math.hypot(gx - s.gx, gy - s.gy) < s.radius + 1.4) return false;
    }
    for (const lk of lakes) {
      const lu = lk.gx - lk.gy;
      const lv = lk.gx + lk.gy;
      if (Math.hypot(u - lu, v - lv) < Math.max(lk.rx, lk.ry) + pad + 1) return false;
    }
    for (let i = 1; i < map.river.length; i++) {
      if (segDist(gx, gy, map.river[i - 1], map.river[i]) < 1.8) return false;
    }
    for (const rd of map.roads) {
      for (let i = 1; i < rd.pts.length; i++) {
        if (segDist(gx, gy, rd.pts[i - 1], rd.pts[i]) < pad) return false;
      }
    }
    return true;
  };

  /* ---- rooftops, for the birds that come down off the canopy ------------- */
  const roofs: WRoof[] = [];
  for (const s of map.sites) {
    for (const b of s.buildings) {
      const r = roofRidge(b);
      if (r) roofs.push(r);
    }
  }

  /* ---- the horse paddock, on the edge of the biggest town ---------------- *
   * "Biggest" is first choice, not the only one: a big town is a *busy* town,
   * and in a valley whose largest holding has four lanes coming out of it there
   * may simply be nowhere left to keep a horse. So the next two down get asked
   * in turn rather than the feature quietly not shipping. */
  const bySize = map.sites.slice().sort((a, b) => b.buildings.length - a.buildings.length);
  /** One picket panel spans 34 art px, which is 34/TW tiles along its own
   * diagonal — the same step `gen.ts` lays its field fences on. */
  const PANEL = 34 / TW;
  let paddock: WPaddock | null = null;
  // Two passes, the second a shade less fussy. Every one of these searches is
  // written this way: a wooded valley whose biggest town happens to sit in a
  // fork of two lanes should still get its horses, just further out.
  for (const room of [1, 0.78]) {
    for (const site of bySize) {
      for (let a = 0; a < 120 && !paddock; a++) {
        const ang = rr() * Math.PI * 2;
        const rad = site.radius + 2.4 + rr() * 6;
        const gx = site.gx + Math.cos(ang) * rad;
        const gy = site.gy + Math.sin(ang) * rad;
        if (!clearAt(gx, gy, 1.6 * room, 2 * room)) continue;
        // The run goes *up-screen* of the horses, so the depth sort puts the
        // rail behind them and the paddock reads as enclosed, not fenced off.
        const alongGx = rr() < 0.5;
        const kind = alongGx ? 'fenceL' : 'fenceR';
        const dx = alongGx ? PANEL : 0;
        const dy = alongGx ? 0 : PANEL;
        const n = 2 + (rr() < 0.5 ? 0 : 1);
        const fx = gx - 1.5 - (dx * (n - 1)) / 2;
        const fy = gy - 1.5 - (dy * (n - 1)) / 2;
        const fence: WPaddock['fence'] = [];
        for (let k = 0; k < n; k++) {
          const px = fx + dx * k;
          const py = fy + dy * k;
          if (!clearAt(px, py, 1.2 * room, 1.2 * room)) break;
          fence.push({ gx: px, gy: py, kind });
        }
        if (fence.length < 2) continue;
        paddock = { gx, gy, fence };
      }
      if (paddock) break;
    }
    if (paddock) break;
  }

  /* ---- the pasture, somewhere in the farmland ---------------------------- */
  const farm = map.chunks.filter((c) => c.biome === 'farm');
  const green = map.chunks.filter((c) => c.biome === 'farm' || c.biome === 'meadow');
  const inChunk = (ch: GenesisMap['chunks'][number]): Vec2 => {
    const u = ch.u0 + 1.5 + rr() * Math.max(0.1, ch.u1 - ch.u0 - 3);
    const v = ch.v0 + 1.5 + rr() * Math.max(0.1, ch.v1 - ch.v0 - 3);
    return [(u + v) / 2, (v - u) / 2];
  };
  const openIn = (
    stock: GenesisMap['chunks'],
    tries: number,
    pad: number,
    clear: number
  ): Vec2 | null => {
    for (let a = 0; a < tries && stock.length; a++) {
      const at = inChunk(stock[Math.floor(rr() * stock.length)]);
      if (clearAt(at[0], at[1], pad, clear)) return at;
    }
    return null;
  };
  // Farmland first, because that is where cattle belong; open meadow after,
  // because a herd on the green is better than no herd at all.
  const pasture = openIn(farm, 240, 1.5, 1.9) ?? openIn(green, 240, 1.3, 1.4);

  /* ---- and one field margin for the fox ---------------------------------- *
   * A straight run of open ground a dozen tiles long, laid on one of the eight
   * compass directions so it reads as a hedge line rather than as an animal
   * cutting across a field. Sampled, not swept: a fox is allowed to pass behind
   * a tree, it just may not spend the whole sighting behind one. */
  let edge: [Vec2, Vec2] | null = null;
  for (const room of [1, 0.72, 0.5]) {
    for (let a = 0; a < 240 && !edge && green.length; a++) {
      const A = inChunk(green[Math.floor(rr() * green.length)]);
      if (!clearAt(A[0], A[1], 1.2 * room, 1.2 * room)) continue;
      const d = dirs[Math.floor(rr() * dirs.length)];
      // A looser pass takes a shorter beat too: a fox that only has eight tiles
      // of margin is still a fox, and eight tiles is twenty seconds of it.
      const L = (5 + 7 * room + rr() * 2) / (Math.hypot(d[0], d[1]) || 1);
      const B: Vec2 = [A[0] + d[0] * L, A[1] + d[1] * L];
      let ok = 0;
      for (let k = 1; k <= 4; k++) {
        const t = k / 4;
        if (clearAt(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, 1.1 * room, 1.1 * room)) {
          ok++;
        }
      }
      if (ok < 3) continue;
      edge = [A, B];
    }
    if (edge) break;
  }

  /* ---- is tonight a fox night? ------------------------------------------- *
   * This has to be a *world* question, not a wildlife-stream one: the wildlife
   * stream is seeded from a constant, so a draw off it would give the same
   * answer in every valley there has ever been — a fox on every night or on no
   * night at all. So it comes off the map's own substream, where "one night in
   * three" means one seed in three, which is what a visitor actually sees. */
  const foxNight = rr() < FOX_CHANCE;
  const foxAt = FOX_FROM + rr() * 0.8;

  /* ---- and the biggest piece of standing water, for the ducks ------------ */
  let lake: LakeSpec | null = null;
  for (const lk of lakes) {
    if (lk.rx < 2.2 || lk.ry < 2.2) continue;
    if (!lake || lk.rx * lk.ry > lake.rx * lake.ry) lake = lk;
  }

  return {
    wet,
    spots,
    flock,
    rgeo: map.river.length >= 2 ? cumulative(map.river) : null,
    roofs,
    paddock,
    pasture,
    edge,
    lake,
    foxNight,
    foxAt,
  };
}

/**
 * Where the ridge of a finished building runs, in world pixels relative to its
 * ground anchor. This is `drawRoof`'s own geometry read back out: a gable and a
 * thatch share a ridge between the two eave midpoints, a hip comes to a point,
 * and a flat roof is a deck a bird can stand anywhere on.
 *
 * Roofs that carry furniture — a mill's sails, a granary silo, a tower, a
 * brewhouse kiln, a gildhall's lamp, anything with a cupola — are declined
 * rather than dodged: there is no shortage of cottages, and a bird standing
 * inside a windmill's sweep is worse than no bird at all.
 */
function roofRidge(b: BuildingSpec): WRoof | null {
  if (b.cupola) return null;
  if (
    b.role === 'tower' ||
    b.role === 'mill' ||
    b.role === 'granary' ||
    b.role === 'brewhouse' ||
    b.role === 'gildhall'
  ) {
    return null;
  }
  const W = Math.max(16, Math.round(b.w / 4) * 4);
  const wallH = b.floors * STORY;
  const base = { bid: b.id, gx: b.gx, gy: b.gy };
  if (b.roof === 'flat') {
    const y = -wallH - 5;
    return { ...base, ax: -W / 4, ay: y, bx: W / 4, by: y };
  }
  const roofH = Math.round(W * (b.roof === 'thatch' ? 0.34 : 0.3));
  if (b.roof === 'hip') {
    // An apex is a point, not a line; give it a pixel either side so a hop
    // still moves the bird instead of jittering it in place.
    const y = -wallH - roofH + 1;
    return { ...base, ax: -1.5, ay: y, bx: 1.5, by: y };
  }
  const RW = W + 8;
  return {
    ...base,
    ax: -RW / 4,
    ay: -wallH - RW / 8 - roofH,
    bx: RW / 4,
    by: -wallH + RW / 8 - roofH,
  };
}

function ensureWild(scene: GenesisScene): Wildlife {
  let wl = WILD.get(scene);
  if (wl) return wl;
  wl = {
    ready: false,
    rng: mulberry32(WILD_SEED),
    clock: -1,
    cache: wildCache(scene),
    birds: [],
    perch: [],
    flies: [],
    deer: [],
    sheep: [],
    horses: [],
    cows: [],
    fox: null,
    ducks: [],
    herder: null,
    dogs: [],
    fish: [],
    rings: [],
    seen: new Set(),
    treeSize: -1,
    vis: 0,
    deerCool: 0,
    fishT: 6,
    dogT: 0,
    perchT: 0,
    perchScan: 0,
    foxNight: false,
    foxAt: FOX_FROM,
    foxDone: false,
    settling: false,
  };
  WILD.set(scene, wl);
  return wl;
}

/**
 * Throw the wildlife away and re-seed it, exactly as `resetAmbient` does for
 * the crowd — and from the same call sites, so a scrub backwards puts the same
 * fireflies over the same marsh every time.
 */
export function resetWildlife(scene: GenesisScene, amb: Ambient, snap: WorldSnapshot): void {
  const wl = ensureWild(scene);
  wl.rng = mulberry32(WILD_SEED);
  wl.clock = -1;
  wl.birds.length = 0;
  wl.perch.length = 0;
  wl.deer.length = 0;
  wl.dogs.length = 0;
  wl.fish.length = 0;
  wl.rings.length = 0;
  wl.deerCool = 0;
  wl.fishT = 6 + wl.rng() * 18;
  wl.dogT = 0;
  // Short, so the settle below lands a bird or two and a frozen tableau opens
  // with the rooftops already occupied.
  wl.perchT = 0.5 + wl.rng() * 2;
  wl.perchScan = 0;
  // Whether tonight is a fox night is a fact about the valley, decided once in
  // the map cache — so a scrub back through the evening finds the same answer,
  // and so does a reload.
  wl.foxNight = wl.cache.foxNight;
  wl.foxAt = wl.cache.foxAt;
  wl.foxDone = false;
  wl.fox = null;
  // Whatever the axe has already got to is history, not an event: only a tree
  // that goes under it while we are watching is worth a bird.
  wl.seen.clear();
  snap.trees.forEach((_v, id) => wl.seen.add(id));
  wl.treeSize = snap.trees.size;
  seedFlies(wl);
  seedFlock(wl);
  seedPaddock(wl);
  seedPasture(wl);
  seedDucks(wl);
  wl.ready = true;
  // Settle, so a paused arrival or a deep link into an hour never opens on a
  // flock standing to attention in a perfect ring.
  const sky = skyAt(snap.t);
  wl.settling = true;
  for (let i = 0; i < 40; i++) stepWildlife(scene, amb, snap, sky, wl, 0.2);
  wl.settling = false;
}

function seedFlies(wl: Wildlife): void {
  wl.flies.length = 0;
  const wet = wl.cache.wet;
  if (!wet.length) return;
  const rng = wl.rng;
  const n = FLY_MIN + Math.floor(rng() * (FLY_MAX - FLY_MIN + 1));
  // A dozen fireflies spread over every marsh on the map is one lonely
  // firefly per marsh. Pick a few pieces of wetland and light those instead.
  const pick = wet.slice();
  for (let i = pick.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = pick[i];
    pick[i] = pick[j];
    pick[j] = t;
  }
  pick.length = Math.min(pick.length, 3);
  for (let i = 0; i < n; i++) {
    const ch = pick[Math.floor(rng() * pick.length)];
    // Chunk bounds are screen-aligned, so this is already a world-pixel box.
    const x = (ch.u0 + rng() * (ch.u1 - ch.u0)) * (TW / 2);
    const y = (ch.v0 + rng() * (ch.v1 - ch.v0)) * (TH / 2);
    wl.flies.push({
      bx: x,
      by: y,
      x,
      y,
      r: 6 + rng() * 12,
      ph: rng() * 12,
      sp: 0.5 + rng() * 0.5,
      a: rng() * 6.283,
      b: rng() * 6.283,
      c: rng() * 6.283,
    });
  }
}

function seedFlock(wl: Wildlife): void {
  wl.sheep.length = 0;
  wl.herder = null;
  const at = wl.cache.flock;
  if (!at) return;
  const rng = wl.rng;
  const n = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const r = 1 + rng() * 2.2;
    wl.sheep.push({
      gx: at[0] + Math.cos(a) * r,
      gy: at[1] + Math.sin(a) * r,
      tx: at[0],
      ty: at[1],
      timer: rng() * 4,
      graze: rng() < 0.6,
      face: rng() < 0.5,
      seed: 400 + Math.floor(rng() * 900),
    });
  }
  const a = rng() * Math.PI * 2;
  wl.herder = {
    gx: at[0] + Math.cos(a) * 3.4,
    gy: at[1] + Math.sin(a) * 3.4,
    tx: at[0],
    ty: at[1],
    timer: 1 + rng() * 3,
    phase: rng() * 8,
    walking: false,
    face: rng() < 0.5,
    color: BOT_COLORS[Math.floor(rng() * BOT_COLORS.length)],
  };
}

/* -------------------------------- the tick -------------------------------- */

/**
 * Advance the wildlife and hand it back to the renderer. `dt` is taken from the
 * renderer's clock, which is the same clock the crowd's phases run on and which
 * stops dead when the world is paused or the visitor asked for less motion.
 */
function tickWildlife(
  scene: GenesisScene,
  amb: Ambient,
  snap: WorldSnapshot,
  sky: Sky,
  clock: number
): Wildlife {
  const wl = ensureWild(scene);
  if (!wl.ready) resetWildlife(scene, amb, snap);
  let dt = wl.clock < 0 ? 0 : clock - wl.clock;
  wl.clock = clock;
  // A speed change or a tab coming back from the background can hand us a
  // second of clock in one frame; nothing here is worth catching up on.
  if (!(dt > 0) || dt > 0.5) dt = 0;

  // Visible even while frozen: fireflies are lit at 21:30 whether or not the
  // player is running, and deer are standing at the treeline at half six.
  wl.vis = clamp01((sky.night - 0.5) / 0.22) * (snap.t > 23.2 ? clamp01((23.7 - snap.t) / 0.5) : 1);
  stepDeerSpawn(wl, snap, dt);
  if (dt > 0) stepWildlife(scene, amb, snap, sky, wl, dt);
  return wl;
}

function stepWildlife(
  scene: GenesisScene,
  amb: Ambient,
  snap: WorldSnapshot,
  sky: Sky,
  wl: Wildlife,
  dt: number
): void {
  stepBursts(scene, wl, snap);
  stepBirds(wl, dt);
  stepPerch(scene, amb, wl, snap, dt);
  stepFlies(wl, dt);
  stepDeer(scene, amb, wl, dt);
  stepFlock(wl, dt);
  stepHorses(wl, dt);
  stepCows(wl, dt);
  stepFox(wl, snap, dt);
  stepDucks(wl, dt, sky);
  stepDogs(scene, amb, wl, dt);
  stepFish(scene, wl, dt, sky);
}

/* ------------------------- birds out of a felled tree --------------------- */

/**
 * The one piece of ambience that is synced to the day itself. `snap.trees` only
 * ever gains entries, and only when the timeline puts a tree under the axe, so
 * the entry count is a sufficient trigger: when it moves, the ids that are new
 * to us and currently `felling` are the trees that just took their first blow.
 */
function stepBursts(scene: GenesisScene, wl: Wildlife, snap: WorldSnapshot): void {
  if (snap.trees.size === wl.treeSize) return;
  wl.treeSize = snap.trees.size;
  const fresh: string[] = [];
  snap.trees.forEach((state, id) => {
    if (wl.seen.has(id)) return;
    wl.seen.add(id);
    if (state === 'felling') fresh.push(id);
  });
  // More than a handful at once is a scrub or a fast-forward, not a moment.
  if (!fresh.length || fresh.length > 5) return;
  for (let i = 0; i < Math.min(2, fresh.length); i++) burst(scene, wl, fresh[i]);
}

function burst(scene: GenesisScene, wl: Wildlife, treeId: string): void {
  const tr = scene.treeById.get(treeId);
  if (!tr) return;
  const p = scene.pools[TREE_POOL[tr.kind] ?? 'oak'];
  const sp = p[Math.abs(tr.seed) % p.length];
  const x = isoX(tr.gx, tr.gy);
  // Out of the canopy, not off the ground: roughly the upper third of the tree.
  const y = isoY(tr.gx, tr.gy) - sp.oy * 0.72;
  const rng = wl.rng;
  const n = 2 + Math.floor(rng() * 3);
  const away = rng() < 0.5 ? -1 : 1;
  for (let i = 0; i < n; i++) {
    const spread = (rng() - 0.5) * 0.7;
    wl.birds.push({
      x: x + (rng() - 0.5) * 12,
      y: y + (rng() - 0.5) * 8,
      vx: away * (30 + rng() * 34) + spread * 22,
      vy: -(20 + rng() * 16),
      age: 0,
      life: 2.1 + rng() * 0.9,
      ph: rng() * 6,
    });
  }
}

function stepBirds(wl: Wildlife, dt: number): void {
  for (let i = wl.birds.length - 1; i >= 0; i--) {
    const b = wl.birds[i];
    b.age += dt;
    if (b.age > b.life) {
      wl.birds.splice(i, 1);
      continue;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    // The panic goes out of it: the climb flattens and the flap slows.
    b.vy += 13 * dt;
    b.ph += dt * (b.age < 0.8 ? 13 : 8);
  }
}

/* ------------------------- fireflies over the marsh ----------------------- */

function stepFlies(wl: Wildlife, dt: number): void {
  if (wl.vis <= 0.01) return;
  for (const f of wl.flies) {
    f.ph += dt * f.sp;
    f.x = f.bx + Math.sin(f.ph * 0.71 + f.a) * f.r;
    f.y = f.by + Math.sin(f.ph * 0.53 + f.b) * f.r * 0.5;
  }
}

/* --------------------------- deer at the treeline ------------------------- */

function inDeerWindow(t: number): boolean {
  for (const [a, b] of DEER_WINDOWS) if (t >= a && t < b) return true;
  return false;
}

/** Spawning is clock-free, so a frozen world still has deer standing in it. */
function stepDeerSpawn(wl: Wildlife, snap: WorldSnapshot, dt: number): void {
  wl.deerCool -= dt;
  if (!inDeerWindow(snap.t)) {
    if (wl.deer.length) wl.deer.length = 0;
    return;
  }
  if (wl.deer.length || wl.deerCool > 0 || !wl.cache.spots.length) return;
  const rng = wl.rng;
  const spot = wl.cache.spots[Math.floor(rng() * wl.cache.spots.length)];
  const n = rng() < 0.55 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const gx = spot.gx + (rng() - 0.5) * 2.4;
    const gy = spot.gy + (rng() - 0.5) * 2.4;
    wl.deer.push({
      gx,
      gy,
      tx: gx,
      ty: gy,
      st: 0,
      timer: 1 + rng() * 3,
      headT: rng() * 2,
      head: rng() < 0.6 ? 1 : 0,
      face: spot.ix < 0,
      vx: spot.ix,
      vy: spot.iy,
      seed: 900 + Math.floor(rng() * 900),
    });
  }
}

function stepDeer(scene: GenesisScene, amb: Ambient, wl: Wildlife, dt: number): void {
  if (!wl.deer.length) return;
  const rng = wl.rng;
  for (let i = wl.deer.length - 1; i >= 0; i--) {
    const d = wl.deer[i];

    if (d.st !== 2) {
      /* ---- is anyone coming? -------------------------------------------- */
      let spook: Vec2 | null = null;
      for (const b of amb.bots) {
        if (Math.abs(b.gx - d.gx) > DEER_SPOOK || Math.abs(b.gy - d.gy) > DEER_SPOOK) continue;
        if (Math.hypot(b.gx - d.gx, b.gy - d.gy) < DEER_SPOOK) {
          spook = [b.gx, b.gy];
          break;
        }
      }
      if (!spook) {
        for (const w of amb.walkers) {
          if (Math.abs(w.gx - d.gx) > DEER_SPOOK || Math.abs(w.gy - d.gy) > DEER_SPOOK) continue;
          if (Math.hypot(w.gx - d.gx, w.gy - d.gy) < DEER_SPOOK) {
            spook = [w.gx, w.gy];
            break;
          }
        }
      }
      if (spook) {
        // Home is the wood, unless the wood is where the trouble is coming from.
        let ax = d.gx - spook[0];
        let ay = d.gy - spook[1];
        const al = Math.hypot(ax, ay) || 1;
        ax /= al;
        ay /= al;
        const toward = ax * d.vx + ay * d.vy;
        if (toward < -0.2) {
          d.vx = ax;
          d.vy = ay;
        }
        d.st = 2;
        d.timer = 2 + rng() * 0.9;
        d.face = d.vx - d.vy > 0;
        continue;
      }
    }

    if (d.st === 2) {
      const sp = 3.6;
      d.gx += d.vx * sp * dt;
      d.gy += d.vy * sp * dt;
      d.timer -= dt;
      if (d.timer <= 0) {
        wl.deer.splice(i, 1);
        // Once the wood has them they stay in it for a while.
        wl.deerCool = 30 + rng() * 50;
      }
      continue;
    }

    d.headT -= dt;
    if (d.headT <= 0) {
      d.head = d.head ? 0 : 1;
      d.headT = (d.head ? 2.2 : 1.4) + rng() * 2.2;
    }

    if (d.st === 1) {
      const dx = d.tx - d.gx;
      const dy = d.ty - d.gy;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.15) {
        d.st = 0;
        d.timer = 2 + rng() * 5;
      } else {
        const step = Math.min(dist, 0.62 * dt);
        d.gx += (dx / dist) * step;
        d.gy += (dy / dist) * step;
        const sdx = dx - dy;
        if (Math.abs(sdx) > 0.01) d.face = sdx > 0;
        d.head = 0;
        d.headT = 0.6;
      }
      continue;
    }

    d.timer -= dt;
    if (d.timer <= 0) {
      if (rng() < 0.6) {
        const a = rng() * Math.PI * 2;
        const r = 0.8 + rng() * 2.4;
        d.tx = d.gx + Math.cos(a) * r;
        d.ty = d.gy + Math.sin(a) * r;
        d.st = 1;
      }
      d.timer = 2 + rng() * 5;
    }
  }
}

/* --------------------------- shepherd and flock --------------------------- */

function stepFlock(wl: Wildlife, dt: number): void {
  const at = wl.cache.flock;
  if (!at) return;
  const rng = wl.rng;

  for (const s of wl.sheep) {
    s.timer -= dt;
    const dx = s.tx - s.gx;
    const dy = s.ty - s.gy;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.12 && !s.graze) {
      const step = Math.min(dist, 0.3 * dt);
      s.gx += (dx / dist) * step;
      s.gy += (dy / dist) * step;
      const sdx = dx - dy;
      if (Math.abs(sdx) > 0.01) s.face = sdx > 0;
    }
    if (s.timer > 0) continue;
    s.graze = !s.graze;
    s.timer = s.graze ? 3 + rng() * 5 : 2 + rng() * 4;
    if (!s.graze) {
      // Sheep drift, but never far: the flock stays a flock.
      const a = rng() * Math.PI * 2;
      const r = 0.8 + rng() * 2.4;
      s.tx = at[0] + Math.cos(a) * r;
      s.ty = at[1] + Math.sin(a) * r;
    }
  }

  const h = wl.herder;
  if (!h) return;
  h.phase += dt;
  const dx = h.tx - h.gx;
  const dy = h.ty - h.gy;
  const dist = Math.hypot(dx, dy);
  if (dist > 0.2) {
    const step = Math.min(dist, 0.7 * dt);
    h.gx += (dx / dist) * step;
    h.gy += (dy / dist) * step;
    const sdx = dx - dy;
    if (Math.abs(sdx) > 0.01) h.face = sdx > 0;
    h.walking = true;
    return;
  }
  h.walking = false;
  h.timer -= dt;
  if (h.timer > 0) return;
  // Tending, loosely: a slow circuit of the flock at arm's length.
  const a = rng() * Math.PI * 2;
  const r = 2.6 + rng() * 2;
  h.tx = at[0] + Math.cos(a) * r;
  h.ty = at[1] + Math.sin(a) * r;
  h.timer = 3 + rng() * 6;
}

/* ------------------------------ the paddock ------------------------------- */

function seedPaddock(wl: Wildlife): void {
  wl.horses.length = 0;
  const pad = wl.cache.paddock;
  if (!pad) return;
  const rng = wl.rng;
  const n = rng() < 0.55 ? 2 : 1;
  for (let i = 0; i < Math.min(HORSE_MAX, n); i++) {
    const a = rng() * Math.PI * 2;
    const r = 0.6 + rng() * 1.4;
    const gx = pad.gx + Math.cos(a) * r;
    const gy = pad.gy + Math.sin(a) * r;
    wl.horses.push({
      gx,
      gy,
      tx: gx,
      ty: gy,
      timer: 1 + rng() * 5,
      headT: rng() * 3,
      head: rng() < 0.7 ? 1 : 0,
      face: rng() < 0.5,
      seed: 1300 + Math.floor(rng() * 900),
    });
  }
}

/**
 * A horse in a paddock has nowhere to be. It puts its head down, picks it up,
 * walks two lengths and puts it down again — and, unlike the deer, nothing on
 * the ground can make it do anything else: a bolting horse would pull the eye
 * clean off whatever the day is actually doing.
 */
function stepHorses(wl: Wildlife, dt: number): void {
  const pad = wl.cache.paddock;
  if (!pad || !wl.horses.length) return;
  const rng = wl.rng;
  for (const h of wl.horses) {
    h.headT -= dt;
    if (h.headT <= 0) {
      h.head = h.head ? 0 : 1;
      h.headT = (h.head ? 4 + rng() * 6 : 2 + rng() * 4) * 1;
    }
    const dx = h.tx - h.gx;
    const dy = h.ty - h.gy;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.12) {
      const step = Math.min(dist, 0.34 * dt);
      h.gx += (dx / dist) * step;
      h.gy += (dy / dist) * step;
      const sdx = dx - dy;
      if (Math.abs(sdx) > 0.01) h.face = sdx > 0;
      h.head = 0;
      h.headT = Math.max(h.headT, 0.8);
      continue;
    }
    h.timer -= dt;
    if (h.timer > 0) continue;
    if (rng() < 0.5) {
      const a = rng() * Math.PI * 2;
      const r = 0.5 + rng() * 1.6;
      h.tx = pad.gx + Math.cos(a) * r;
      h.ty = pad.gy + Math.sin(a) * r;
    }
    h.timer = 5 + rng() * 9;
  }
}

/* ------------------------------- the pasture ------------------------------ */

function seedPasture(wl: Wildlife): void {
  wl.cows.length = 0;
  const at = wl.cache.pasture;
  if (!at) return;
  const rng = wl.rng;
  const n = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < Math.min(COW_MAX, n); i++) {
    const a = rng() * Math.PI * 2;
    const r = 0.8 + rng() * 1.8;
    const gx = at[0] + Math.cos(a) * r;
    const gy = at[1] + Math.sin(a) * r;
    wl.cows.push({
      gx,
      gy,
      tx: gx,
      ty: gy,
      timer: rng() * 6,
      graze: rng() < 0.7,
      face: rng() < 0.5,
      seed: 1700 + Math.floor(rng() * 900),
    });
  }
}

/** Cattle, on the flock's own state machine with the speeds halved. */
function stepCows(wl: Wildlife, dt: number): void {
  const at = wl.cache.pasture;
  if (!at || !wl.cows.length) return;
  const rng = wl.rng;
  for (const c of wl.cows) {
    c.timer -= dt;
    const dx = c.tx - c.gx;
    const dy = c.ty - c.gy;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.12 && !c.graze) {
      const step = Math.min(dist, 0.22 * dt);
      c.gx += (dx / dist) * step;
      c.gy += (dy / dist) * step;
      const sdx = dx - dy;
      if (Math.abs(sdx) > 0.01) c.face = sdx > 0;
    }
    if (c.timer > 0) continue;
    c.graze = !c.graze;
    c.timer = c.graze ? 6 + rng() * 8 : 3 + rng() * 5;
    if (!c.graze) {
      const a = rng() * Math.PI * 2;
      const r = 0.8 + rng() * 2;
      c.tx = at[0] + Math.cos(a) * r;
      c.ty = at[1] + Math.sin(a) * r;
    }
  }
}

/* --------------------------- the fox, some nights ------------------------- */

/**
 * One animal, one beat, one night in three — and never during a settle, so a
 * frozen valley has no fox in it at all. That is the whole design: it has to be
 * something a visitor catches, not something they can go and look at.
 */
function stepFox(wl: Wildlife, snap: WorldSnapshot, dt: number): void {
  const edge = wl.cache.edge;
  if (!edge) return;
  const out = snap.t < FOX_FROM || snap.t >= FOX_TO;
  if (out) {
    // A new evening rearms it; anything outside the window puts it away.
    if (wl.fox) wl.fox = null;
    if (snap.t < FOX_FROM) wl.foxDone = false;
    return;
  }
  if (!wl.fox) {
    if (wl.settling || wl.foxDone || !wl.foxNight || snap.t < wl.foxAt) return;
    const rng = wl.rng;
    // Which end it comes in at. `sp` carries the sign, so the step below needs
    // no second field to remember which way round the beat is being walked.
    const back = rng() < 0.5;
    const A = back ? edge[1] : edge[0];
    const B = back ? edge[0] : edge[1];
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
    wl.fox = {
      gx: A[0],
      gy: A[1],
      k: 0,
      // Tiles a second, normalised to the length of the beat. Quicker than a
      // deer ambles and slower than a settler walks, which between them is the
      // whole of what "trotting" looks like from across a valley.
      sp: ((back ? -1 : 1) * (1.1 + rng() * 0.4)) / len,
      st: 1,
      timer: 3 + rng() * 5,
      face: B[0] - A[0] - (B[1] - A[1]) > 0,
      phase: 0,
      pose: 0,
    };
    return;
  }

  const f = wl.fox;
  const rng = wl.rng;
  const back = f.sp < 0;
  const A = edge[0];
  const B = edge[1];
  f.timer -= dt;
  if (f.st === 1) {
    f.k += Math.abs(f.sp) * dt;
    f.phase += dt;
    f.pose = Math.floor(f.phase * 6) % 2 === 0 ? 0 : 1;
    if (f.k >= 1) {
      wl.fox = null;
      wl.foxDone = true;
      return;
    }
    if (f.timer <= 0) {
      // Stops, listens, moves on. This is most of what makes it read as a fox.
      f.st = 0;
      f.timer = 1.2 + rng() * 2.2;
    }
  } else if (f.timer <= 0) {
    f.st = 1;
    f.timer = 3 + rng() * 6;
  }
  const t = back ? 1 - f.k : f.k;
  f.gx = A[0] + (B[0] - A[0]) * t;
  f.gy = A[1] + (B[1] - A[1]) * t;
}

/* --------------------------------- ducks ---------------------------------- */

function seedDucks(wl: Wildlife): void {
  wl.ducks.length = 0;
  const lk = wl.cache.lake;
  if (!lk) return;
  const rng = wl.rng;
  const n = 3 + Math.floor(rng() * 2);
  // Inside the analytic ellipse with a margin, so a duck never drifts onto the
  // bank however the outline wobbles.
  const ru = Math.max(1, lk.rx * 0.5);
  const rv = Math.max(1, lk.ry * 0.5);
  const lu = lk.gx - lk.gy;
  const lv = lk.gx + lk.gy;
  for (let i = 0; i < Math.min(DUCK_MAX, n); i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng());
    const u = lu + Math.cos(lk.rot) * Math.cos(a) * ru * r - Math.sin(lk.rot) * Math.sin(a) * rv * r;
    const v = lv + Math.sin(lk.rot) * Math.cos(a) * ru * r + Math.cos(lk.rot) * Math.sin(a) * rv * r;
    const gx = (u + v) / 2;
    const gy = (v - u) / 2;
    wl.ducks.push({
      bx: gx,
      by: gy,
      gx,
      gy,
      r: 0.5 + rng() * 0.7,
      ph: rng() * 12,
      sp: 0.16 + rng() * 0.14,
      a: rng() * 6.283,
      b: rng() * 6.283,
      face: rng() < 0.5,
    });
  }
}

/** A duck does not swim anywhere; it drifts. Two slow sines, like a firefly
 * with the speed taken out of it and the height taken off. */
function stepDucks(wl: Wildlife, dt: number, sky: Sky): void {
  if (!wl.ducks.length || sky.night > 0.5) return;
  for (const d of wl.ducks) {
    d.ph += dt * d.sp;
    const gx = d.bx + Math.sin(d.ph * 0.83 + d.a) * d.r;
    const gy = d.by + Math.sin(d.ph * 0.61 + d.b) * d.r;
    const sdx = gx - d.gx - (gy - d.gy);
    if (Math.abs(sdx) > 0.0008) d.face = sdx > 0;
    d.gx = gx;
    d.gy = gy;
  }
}

/* ------------------------- birds on a finished roof ----------------------- */

/**
 * The calm counterpart to the chop burst. A bird comes down onto a ridge, sits
 * there for the best part of a minute, hops along it once or twice, and goes —
 * unless somebody walks under the eaves first, in which case it goes rather
 * sooner and rather less tidily.
 */
function stepPerch(
  scene: GenesisScene,
  amb: Ambient,
  wl: Wildlife,
  snap: WorldSnapshot,
  dt: number
): void {
  const rng = wl.rng;
  const roofs = wl.cache.roofs;
  const daylight = snap.t >= PERCH_FROM && snap.t < PERCH_TO;

  /* ---- landing ---------------------------------------------------------- */
  wl.perchT -= dt;
  if (wl.perchT <= 0) {
    wl.perchT = 6 + rng() * 14;
    if (daylight && wl.perch.length < PERCH_MAX && roofs.length) {
      for (let a = 0; a < 6; a++) {
        const rf = roofs[Math.floor(rng() * roofs.length)];
        if (snap.buildings.get(rf.bid)?.status !== 'done') continue;
        if (wl.perch.some((p) => p.roof.bid === rf.bid)) continue;
        wl.perch.push({
          roof: rf,
          u: PERCH_U0 + rng() * (PERCH_U1 - PERCH_U0),
          face: rng() < 0.5,
          life: 20 + rng() * 40,
          hop: 4 + rng() * 9,
          ph: rng() * 6,
        });
        break;
      }
    }
  }
  if (!wl.perch.length) return;

  /* ---- anybody coming? --------------------------------------------------- */
  // On a coarse cadence: three birds against a pace-4 crowd every frame would
  // cost more than the rest of the wildlife put together, and a bird that takes
  // a third of a second to notice a passing cart is a bird.
  let flush = -1;
  wl.perchScan -= dt;
  if (wl.perchScan <= 0) {
    wl.perchScan = 0.35;
    outer: for (let i = 0; i < wl.perch.length; i++) {
      const rf = wl.perch[i].roof;
      // Somebody *passing*, not somebody there. A crew stands at a plot for
      // half the afternoon; if standing about counted, no bird would ever get
      // to sit down in a town at all.
      for (const b of amb.bots) {
        if (b.action !== 'walk') continue;
        if (Math.abs(b.gx - rf.gx) > PERCH_SPOOK || Math.abs(b.gy - rf.gy) > PERCH_SPOOK) continue;
        if (rng() < PERCH_FLUSH) {
          flush = i;
          break outer;
        }
      }
      for (const w of amb.walkers) {
        if (Math.abs(w.gx - rf.gx) > PERCH_SPOOK || Math.abs(w.gy - rf.gy) > PERCH_SPOOK) continue;
        if (rng() < PERCH_FLUSH) {
          flush = i;
          break outer;
        }
      }
    }
  }

  for (let i = wl.perch.length - 1; i >= 0; i--) {
    const p = wl.perch[i];
    p.life -= dt;
    p.hop -= dt;
    if (p.hop <= 0) {
      // A hop is a step along the ridge and, half the time, a turn on the spot.
      const d = (rng() < 0.5 ? -1 : 1) * (0.1 + rng() * 0.18);
      const u = p.u + d;
      p.u = u < PERCH_U0 ? PERCH_U0 : u > PERCH_U1 ? PERCH_U1 : u;
      if (rng() < 0.5) p.face = !p.face;
      p.hop = 4 + rng() * 9;
    }
    if (p.life > 0 && i !== flush && daylight) continue;
    // Off it goes: the perch becomes an ordinary flying bird, one storey up.
    const at = perchAt(p);
    const away = p.face ? 1 : -1;
    wl.birds.push({
      x: at[0],
      y: at[1] - 2,
      vx: away * (26 + rng() * 30),
      vy: -(18 + rng() * 14),
      age: 0,
      life: 1.8 + rng() * 0.9,
      ph: p.ph,
    });
    wl.perch.splice(i, 1);
  }
}

/** World-pixel position of a perched bird's feet. */
function perchAt(p: WPerch): Vec2 {
  const r = p.roof;
  return [
    isoX(r.gx, r.gy) + r.ax + (r.bx - r.ax) * p.u,
    isoY(r.gx, r.gy) + r.ay + (r.by - r.ay) * p.u,
  ];
}

/* ---------------------------- dogs behind carts --------------------------- */

function stepDogs(scene: GenesisScene, amb: Ambient, wl: Wildlife, dt: number): void {
  wl.dogT -= dt;
  if (wl.dogT <= 0) {
    wl.dogT = 0.75;
    // A walker can be retired by `syncAmbient` at any time; a dog whose cart is
    // gone goes with it.
    for (let i = wl.dogs.length - 1; i >= 0; i--) {
      if (amb.walkers.indexOf(wl.dogs[i].w) < 0) wl.dogs.splice(i, 1);
    }
    if (wl.dogs.length < 2) {
      for (const w of amb.walkers) {
        if (!w.cart) continue;
        if (wl.dogs.some((d) => d.w === w)) continue;
        if (wl.rng() < 0.45) continue; // not every cart has a dog
        wl.dogs.push({
          w,
          back: 1.6,
          want: 1.4,
          timer: 1 + wl.rng() * 3,
          gx: w.gx,
          gy: w.gy,
          face: w.faceRight,
          phase: wl.rng() * 6,
          pose: 0,
        });
        if (wl.dogs.length >= 2) break;
      }
    }
  }

  for (const d of wl.dogs) {
    const road = scene.roadById.get(d.w.roadId);
    const geo = road ? scene.roadGeo.get(d.w.roadId) : undefined;
    if (!road || !geo) continue;
    d.timer -= dt;
    if (d.timer <= 0) {
      // Something in the verge is worth a sniff; then it has to catch up.
      const dawdling = d.want > 2.4;
      d.want = dawdling ? 1.2 + wl.rng() * 0.7 : 3 + wl.rng() * 1.2;
      d.timer = dawdling ? 2.5 + wl.rng() * 4 : 1.2 + wl.rng() * 1.6;
    }
    d.back += (d.want - d.back) * Math.min(1, dt * 1.5);
    const s = Math.max(0, Math.min(geo.len, d.w.s - d.back * d.w.dir));
    const at = alongPolyline(road.pts, geo, s);
    const moved = Math.hypot(at[0] - d.gx, at[1] - d.gy);
    const sdx = at[0] - d.gx - (at[1] - d.gy);
    if (Math.abs(sdx) > 0.001) d.face = sdx > 0;
    d.gx = at[0];
    d.gy = at[1];
    if (moved > 0.004) {
      d.phase += dt;
      d.pose = Math.floor(d.phase * 7) % 2 === 0 ? 0 : 1;
    }
  }
}

/* ------------------------------- fish jumps ------------------------------- */

function stepFish(scene: GenesisScene, wl: Wildlife, dt: number, sky: Sky): void {
  const geo = wl.cache.rgeo;
  const river = scene.map.river;
  if (geo && river.length >= 2) {
    wl.fishT -= dt;
    if (wl.fishT <= 0) {
      // A handful an hour, and none of them in the dark.
      wl.fishT = 14 + wl.rng() * 22;
      if (sky.night < 0.55 && wl.fish.length < 2) {
        const at = alongPolyline(river, geo, wl.rng() * geo.len);
        wl.fish.push({
          x: isoX(at[0], at[1]) + (wl.rng() - 0.5) * 8,
          y: isoY(at[0], at[1]),
          base: isoY(at[0], at[1]),
          vx: (wl.rng() - 0.5) * 22,
          vy: -(30 + wl.rng() * 12),
        });
      }
    }
  }
  for (let i = wl.fish.length - 1; i >= 0; i--) {
    const f = wl.fish[i];
    f.vy += 96 * dt;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    if (f.vy > 0 && f.y >= f.base) {
      wl.rings.push({ x: f.x, y: f.base, age: 0 });
      wl.fish.splice(i, 1);
    }
  }
  for (let i = wl.rings.length - 1; i >= 0; i--) {
    wl.rings[i].age += dt;
    if (wl.rings[i].age > 1.5) wl.rings.splice(i, 1);
  }
}

/* -------------------------------- drawing --------------------------------- */

/**
 * Everything that stands on the ground, as depth-sorted items. Called after
 * the crowd, so these are inside the occlusion-repair budget with it — a deer
 * at a treeline is exactly the case that needs the trunk in front of it back.
 */
function pushWildlife(
  scene: GenesisScene,
  wl: Wildlife,
  items: Item[],
  wx0: number,
  wy0: number,
  wx1: number,
  wy1: number
): void {
  const seen = (x: number, y: number) => x > wx0 && x < wx1 && y > wy0 && y < wy1;
  const add = (sp: Sprite, gx: number, gy: number, bump = 1) => {
    const x = isoX(gx, gy);
    const y = isoY(gx, gy);
    if (!seen(x, y)) return;
    const bx = Math.round(x - sp.ox);
    const by = Math.round(y - sp.oy);
    items.push({
      depth: y + bump,
      bx,
      by,
      bw: sp.c.width,
      bh: sp.c.height,
      draw: (c) => c.drawImage(sp.c, bx, by),
    });
  };

  for (const d of wl.deer) {
    const pose: 0 | 1 | 2 = d.st === 2 ? 2 : d.st === 0 && d.head ? 1 : 0;
    add(
      cached(scene, `wd:${pose}:${d.face ? 1 : 0}:${d.seed % 3}`, () =>
        buildDeer(pose, d.face, d.seed)
      ),
      d.gx,
      d.gy
    );
  }

  for (const s of wl.sheep) {
    add(
      cached(scene, `ws:${s.seed % 4}:${s.face ? 1 : 0}:${s.graze ? 1 : 0}`, () =>
        buildGrazingSheep(s.seed, s.face, s.graze)
      ),
      s.gx,
      s.gy
    );
  }

  /* ---- the paddock, and what is standing in it -------------------------- */
  // The rail is scenery, but scenery the *scene* placed rather than `gen.ts`,
  // so it rides in with the wildlife instead of the bake. Two or three sprites
  // is nothing to redraw, and going through the item pass is what keeps a horse
  // that has walked down-screen of the fence in front of it.
  const pad = wl.cache.paddock;
  if (pad) {
    for (const f of pad.fence) add(scene.pools[f.kind][0], f.gx, f.gy, 0);
  }
  for (const h of wl.horses) {
    add(
      cached(scene, `wh:${h.head}:${h.face ? 1 : 0}:${h.seed % 3}`, () =>
        buildHorse(h.head, h.face, h.seed)
      ),
      h.gx,
      h.gy
    );
  }

  for (const c of wl.cows) {
    add(
      cached(scene, `wc:${c.seed % 4}:${c.face ? 1 : 0}:${c.graze ? 1 : 0}`, () =>
        buildCattle(c.seed, c.face, c.graze)
      ),
      c.gx,
      c.gy
    );
  }

  const fox = wl.fox;
  if (fox) {
    add(
      cached(scene, `wf:${fox.st === 1 ? fox.pose : 0}:${fox.face ? 1 : 0}`, () =>
        buildFox(fox.st === 1 ? fox.pose : 0, fox.face)
      ),
      fox.gx,
      fox.gy
    );
  }

  for (const d of wl.ducks) {
    const x = isoX(d.gx, d.gy);
    const y = isoY(d.gx, d.gy);
    if (!seen(x, y)) continue;
    // The wake first and a shade behind, so the duck sits inside its own ring.
    items.push({
      depth: y - 0.5,
      bx: Math.round(x - 5),
      by: Math.round(y - 3),
      bw: 10,
      bh: 6,
      draw: (c) => drawRipple(c, x, y, 4, 0.3),
    });
    const frame: 0 | 1 = Math.floor(d.ph * 1.7) % 2 === 0 ? 0 : 1;
    add(
      cached(scene, `wk:${frame}:${d.face ? 1 : 0}`, () => buildDuck(frame, d.face)),
      d.gx,
      d.gy
    );
  }

  /* ---- and the birds that are sitting still ------------------------------
   * Depth is the *building's* ground line plus a hair, which is the one number
   * that gets this right: the building itself is an item at exactly that line,
   * so the bird lands on top of its own roof with nothing to tie-break, and any
   * trunk genuinely nearer than the house still sorts in front and is repaired
   * back over it by the pass below. */
  for (const p of wl.perch) {
    const at = perchAt(p);
    if (!seen(at[0], at[1])) continue;
    const sp = cached(scene, `wp:${p.face ? 1 : 0}`, () => buildPerchedBird(p.face));
    const bx = Math.round(at[0] - sp.ox);
    const by = Math.round(at[1] - sp.oy);
    items.push({
      depth: isoY(p.roof.gx, p.roof.gy) + 0.5,
      bx,
      by,
      bw: sp.c.width,
      bh: sp.c.height,
      draw: (c) => c.drawImage(sp.c, bx, by),
    });
  }

  const h = wl.herder;
  if (h) {
    const x = isoX(h.gx, h.gy);
    const y = isoY(h.gx, h.gy);
    if (seen(x, y)) {
      const px = Math.round(x);
      const py = Math.round(y);
      const action: BotAction = h.walking ? 'walk' : 'idle';
      const { color, face, phase } = h;
      items.push({
        depth: y + 1,
        bx: px - 7,
        by: py - 20,
        bw: 15,
        bh: 22,
        draw: (c) => drawBot(c, px, py, color, face, action, phase),
      });
    }
  }

  for (const d of wl.dogs) {
    add(
      cached(scene, `wg:${d.pose}:${d.face ? 1 : 0}`, () => buildDog(d.pose, d.face)),
      d.gx,
      d.gy
    );
  }

  // Rings first, so a fish that is still in the air is over its own splash.
  for (const r of wl.rings) {
    if (!seen(r.x, r.y)) continue;
    const { x, y } = r;
    const rad = 1.5 + r.age * 6;
    const a = Math.max(0, 1 - r.age / 1.5) * 0.75;
    items.push({
      depth: y - 0.5,
      bx: Math.round(x - rad),
      by: Math.round(y - rad / 2),
      bw: Math.ceil(rad * 2),
      bh: Math.ceil(rad),
      draw: (c) => drawRipple(c, x, y, rad, a),
    });
  }
  for (const f of wl.fish) {
    if (!seen(f.x, f.base)) continue;
    const { x, y, vy, base } = f;
    items.push({
      depth: base,
      bx: Math.round(x - 5),
      by: Math.round(y - 2),
      bw: 10,
      bh: 6,
      draw: (c) => drawFishJump(c, x, y, vy),
    });
  }
}

/**
 * Birds, over the finished item pass. They are above the canopy within a frame
 * of leaving it, so they deliberately skip the occlusion-repair pass entirely:
 * there is nothing in the valley that can stand in front of one.
 */
function drawWildlifeAir(
  ctx: Ctx,
  scene: GenesisScene,
  wl: Wildlife,
  wx0: number,
  wy0: number,
  wx1: number,
  wy1: number
): void {
  if (!wl.birds.length) return;
  const f0 = cached(scene, 'wb:0', () => buildBird(0));
  const f1 = cached(scene, 'wb:1', () => buildBird(1));
  for (const b of wl.birds) {
    if (b.x < wx0 || b.x > wx1 || b.y < wy0 || b.y > wy1) continue;
    const sp = Math.floor(b.ph) % 2 === 0 ? f0 : f1;
    const fade = b.age > b.life - 0.5 ? Math.max(0, (b.life - b.age) / 0.5) : 1;
    if (fade < 1) ctx.globalAlpha = fade;
    ctx.drawImage(sp.c, Math.round(b.x) - sp.ox, Math.round(b.y) - sp.oy);
    if (fade < 1) ctx.globalAlpha = 1;
  }
}

/**
 * Fireflies, on the viewport and after the sky — the one thing in the valley
 * that must not be dimmed by the night fill that makes it night. Drawn in
 * device pixels, at least one of them across whatever the zoom is.
 */
function drawFireflies(
  ctx: Ctx,
  wl: Wildlife,
  cx: number,
  cy: number,
  scale: number,
  dw: number,
  dh: number
): void {
  if (wl.vis <= 0.02 || !wl.flies.length) return;
  const px = Math.max(1, Math.round(scale));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const f of wl.flies) {
    const sx = (f.x - cx) * scale;
    const sy = (f.y - cy) * scale;
    if (sx < -4 || sx > dw + 4 || sy < -4 || sy > dh + 4) continue;
    drawFirefly(ctx, sx, sy, fireflyBlink(f.ph, f.c), wl.vis, px);
  }
  ctx.restore();
}

/**
 * Where a firefly is in its blink, 0..1. Cubed, so the dark half of the cycle
 * is long and the bright half is a flash rather than a fade.
 */
export function fireflyBlink(ph: number, c: number): number {
  const s = Math.sin(ph * 1.6 + c);
  return s > 0 ? s * s * s : 0;
}

/**
 * One firefly, in device pixels, on a context already in `lighter`. Exported
 * for the catalog page, which has one marsh and no world behind it.
 */
export function drawFirefly(
  ctx: Ctx,
  x: number,
  y: number,
  blink: number,
  vis: number,
  px = 1
): void {
  // Floored well above nothing, so a frozen tableau still reads as a marsh
  // with fireflies over it rather than as an empty marsh.
  ctx.globalAlpha = vis * (0.2 + 0.8 * blink);
  ctx.fillStyle = blink > 0.4 ? '#f6ffbe' : '#d3ee86';
  ctx.fillRect(Math.round(x), Math.round(y), px, px);
  if (blink > 0.45) {
    // A hair of bloom on the bright half of the blink, so a firefly at the
    // overview is a twinkle rather than a stuck pixel.
    ctx.globalAlpha = vis * 0.34 * blink;
    ctx.fillRect(Math.round(x) - px, Math.round(y), px * 3, px);
    ctx.fillRect(Math.round(x), Math.round(y) - px, px, px * 3);
  }
}
