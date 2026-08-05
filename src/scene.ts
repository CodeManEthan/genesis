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
  buildBush,
  buildCampfire,
  buildCart,
  buildCrane,
  buildCrates,
  buildCropRow,
  buildFence,
  buildFlowerPatch,
  buildForestPattern,
  buildHaystack,
  buildLamp,
  buildLumber,
  buildNameBoard,
  buildReeds,
  buildRock,
  buildSheep,
  buildShed,
  buildSignpost,
  buildStake,
  buildStructure,
  buildStump,
  buildTree,
  buildWell,
  drawBot,
  drawCart,
  drawCraneLoad,
  drawWheel,
  isoTile,
  mix,
  mulberry32,
  poly,
  rect,
  shade,
  type BotAction,
  type Ctx,
  type Pt,
  type Sprite,
  type StructureSprite,
} from '../vale/art';
import {
  TH,
  TW,
  isoX,
  isoY,
  type BuildingSpec,
  type GenesisMap,
  type PropSpec,
  type RoadSpec,
  type SiteSpec,
  type TreeSpec,
  type Vec2,
  type WorldSnapshot,
} from './types';

/* ------------------------------ sprite pools ----------------------------- */

function pool<T>(n: number, make: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => make(i));
}

function makePools(): Record<string, Sprite[]> {
  return {
    oak: pool(6, (i) => buildTree(0, 11 + i * 37)),
    pine: pool(6, (i) => buildTree(1, 23 + i * 41)),
    blossom: pool(4, (i) => buildTree(2, 31 + i * 43)),
    hedgerow: pool(4, (i) => buildTree(3, 47 + i * 29)),
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
  };
}

const TREE_POOL: Record<string, string> = {
  oak: 'oak',
  pine: 'pine',
  blossom: 'blossom',
  hedgerow: 'hedgerow',
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

/** One sprite that lives on the standing-wood layer. */
interface VegItem {
  sprite: Sprite;
  depth: number;
  bx: number;
  by: number;
  bw: number;
  bh: number;
  /** Set for trees; undefined for wild scatter, which never changes state. */
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
}

export interface GView {
  /** World pixel at the top-left of the viewport. */
  cx: number;
  cy: number;
  /** CSS pixels per world pixel. */
  zoom: number;
  vw: number;
  vh: number;
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
function strip(ctx: Ctx, pts: Vec2[], halfW: number, color: string): void {
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

/* ---------------------------------- bake --------------------------------- */

export function buildGenesisScene(map: GenesisMap): GenesisScene {
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
  for (let v = Math.floor(B.v0) - OVER_V; v <= Math.ceil(B.v1) + OVER_V; v++) {
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
      let col = shade(rgbHex(tintAt(u, v)), jitter + n * 0.05);

      const glade = gladeAt(gx, gy);
      if (glade > 0) col = mix(col, PAL.dirtPale, glade * 0.3);

      isoTile(ctx, sx, sy, col);

      const r = grng();
      if (glade < 0.4 && r < 0.09) {
        rect(ctx, sx - 4, sy + 1, 2, 1, PAL.grassEdge);
        rect(ctx, sx + 2, sy - 2, 2, 1, PAL.grassEdge);
      } else if (glade < 0.4 && r < 0.12) {
        rect(ctx, sx, sy - 1, 1, 2, PAL.leafDark);
        rect(ctx, sx, sy - 3, 1, 1, PAL.flower[h % PAL.flower.length]);
      } else if (glade > 0.5 && r < 0.06) {
        rect(ctx, sx - 2, sy, 3, 1, PAL.dirtEdge);
      }
    }
  }

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

  const scene: GenesisScene = {
    map,
    layer,
    lx,
    ly,
    veg: null as unknown as VegLayer,
    surround: buildForestPattern(),
    frame: document.createElement('canvas'),
    pools: makePools(),
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
  };
  scene.veg = buildVeg(scene, W, H);
  return scene;
}

/* --------------------------- the standing wood --------------------------- */

/**
 * Every tree (drawn as if standing) and every wild prop, sorted into one
 * depth-ordered list, indexed by cell, and painted onto a transparent layer that
 * sits exactly on top of the terrain bake. Whether an entry is actually painted
 * is tracked in `on`, so a chopped tree can be lifted off with a small patch.
 */
function buildVeg(scene: GenesisScene, W: number, H: number): VegLayer {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.translate(-scene.lx, -scene.ly);

  const items: VegItem[] = [];
  const add = (sprite: Sprite, gx: number, gy: number, treeId?: string) => {
    const x = isoX(gx, gy);
    const y = isoY(gx, gy);
    items.push({
      sprite,
      depth: y,
      bx: x - sprite.ox,
      by: y - sprite.oy,
      bw: sprite.c.width,
      bh: sprite.c.height,
      treeId,
    });
  };

  for (const tr of scene.map.trees) {
    const p = scene.pools[TREE_POOL[tr.kind] ?? 'oak'];
    add(p[Math.abs(tr.seed) % p.length], tr.gx, tr.gy, tr.id);
  }
  for (const p of scene.map.scatter) {
    const sp = propSprite(scene, p.kind, p.seed, '#63c9a8');
    if (sp) add(sp, p.gx, p.gy);
  }

  items.sort((a, b) => a.depth - b.depth || a.bx - b.bx);

  const grid = new Map<number, number[]>();
  items.forEach((it, i) => {
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
    items,
    grid,
    on: items.map(() => true),
    size: -1,
  };
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
 * Reconcile the standing-wood layer with the snapshot. A tree only leaves the
 * layer when the timeline puts it under the axe, so the entry count of
 * `snap.trees` is a complete fingerprint: the felled set is always a prefix of
 * the chop-start events, forwards or backwards.
 */
export function syncVeg(scene: GenesisScene, snap: WorldSnapshot): void {
  const veg = scene.veg;
  if (veg.size === snap.trees.size) return;
  veg.size = snap.trees.size;

  const changed: number[] = [];
  for (let i = 0; i < veg.items.length; i++) {
    const id = veg.items[i].treeId;
    if (id === undefined) continue;
    const want = (snap.trees.get(id) ?? 'standing') === 'standing';
    if (want !== veg.on[i]) changed.push(i);
  }
  if (!changed.length) return;

  for (const i of changed) veg.on[i] = !veg.on[i];
  // A scrub can move hundreds of trees at once; past a few dozen patches a
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
  return `${snap.founded.size}|${pop}|${b}|${tr}.${snap.trees.size}|${rd}|${snap.props.size}`;
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
  const sig = snapSig(snap);
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
  for (const road of scene.map.roads) {
    const frac = snap.roads.get(road.id) ?? 0;
    if (frac <= 0.5) continue;
    const highway = road.kind === 'highway';
    const want = highway ? 2 : 1;
    const have = onRoad.get(road.id) ?? 0;
    const geo = scene.roadGeo.get(road.id)!;
    for (let i = have; i < want; i++) {
      const s = geo.len * frac * rng();
      const at = alongPolyline(road.pts, geo, s);
      amb.walkers.push({
        roadId: road.id,
        s,
        dir: rng() < 0.5 ? 1 : -1,
        phase: rng() * 8,
        color: BOT_COLORS[Math.floor(rng() * BOT_COLORS.length)],
        gx: at[0],
        gy: at[1],
        faceRight: true,
        cart: highway && i === 0,
        cargo: CARGO_COLORS[Math.floor(rng() * CARGO_COLORS.length)],
      });
    }
  }

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

/** Everything freezes mid-pose while the player is paused; this is only called
 * when the clock is actually running. */
export function stepAmbient(
  scene: GenesisScene,
  amb: Ambient,
  snap: WorldSnapshot,
  dt: number
): void {
  const rng = amb.rng;
  const rate = paceRate(amb);

  for (const site of scene.map.sites) {
    if (!snap.founded.has(site.id)) continue;
    const crew = amb.crews.get(site.id);
    if (!crew || !crew.length) continue;
    const tasks = siteTasks(scene, site, snap);

    crew.forEach((bot, i) => {
      bot.phase += dt * rate;
      if (bot.arrive) {
        stepArrival(scene, bot, site, dt, rate);
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

  stepSmoke(amb, dt);
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
  amb.bots = [];
  amb.crews.clear();
  amb.pop.clear();
  amb.walkers = [];
  amb.smoke = [];
  amb.smokeClock.t = 0;
  amb.sig = '';
  amb.rng = mulberry32(4242);
  syncAmbient(scene, amb, snap);
}

/** Settle the crowd so a paused or reduced-motion visitor gets a lived-in world. */
export function settleAmbient(scene: GenesisScene, amb: Ambient, snap: WorldSnapshot): void {
  syncAmbient(scene, amb, snap);
  for (let i = 0; i < 120; i++) stepAmbient(scene, amb, snap, 1 / 12);
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

export function skyAt(t: number): Sky {
  const h = t <= 0 ? 0 : t >= 24 ? 24 : t;
  let i = 1;
  while (i < SKY.length - 1 && SKY[i][0] < h) i++;
  const a = SKY[i - 1];
  const b = SKY[i];
  const span = b[0] - a[0] || 1;
  let f = (h - a[0]) / span;
  f = f * f * (3 - 2 * f); // smoothstep: no visible kink at a keyframe
  const mix4 = (k: number) => a[k] + (b[k] - a[k]) * f;
  const alpha = mix4(4);
  const night = Math.max(0, Math.min(1, (alpha - 0.16) / 0.42));
  // Last lamp out just before midnight; first hearth lit a few minutes after.
  const gate = h > 23.9 ? Math.max(0, (24 - h) / 0.1) : h < 0.25 ? Math.min(1, h / 0.25) : 1;
  return {
    css: `rgb(${Math.round(mix4(1))},${Math.round(mix4(2))},${Math.round(mix4(3))})`,
    a: alpha,
    lift: mix4(5),
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
  const bw = Math.max(1, Math.ceil(vw / zoom));
  const bh = Math.max(1, Math.ceil(vh / zoom));
  const f = scene.frame;
  if (f.width !== bw || f.height !== bh) {
    f.width = bw;
    f.height = bh;
  }
  const g = f.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.imageSmoothingEnabled = false;

  const sky = skyAt(snap.t);
  scene.lit = sky.night > 0.5;
  scene.relight = 4;
  syncVeg(scene, snap);

  const cx = Math.round(view.cx);
  const cy = Math.round(view.cy);

  /* ---- beyond the map: endless woodland -------------------------------- */
  g.fillStyle = '#3f7f66';
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

  const wx0 = cx - 72;
  // Generous at the top: a mill's sails or a tower's flag can stand 150px above
  // the anchor tile that decides whether the sprite is culled.
  const wy0 = cy - 190;
  const wx1 = cx + bw + 64;
  const wy1 = cy + bh + 64;
  const inView = (x: number, y: number) => x > wx0 && x < wx1 && y > wy0 && y < wy1;

  /* ---- roads, clipped to what has actually been built ------------------ */
  for (const road of scene.map.roads) {
    const frac = snap.roads.get(road.id) ?? 0;
    if (frac <= 0.001) continue;
    const geo = scene.roadGeo.get(road.id)!;
    const pts = cutPolyline(road.pts, geo, frac);
    if (pts.length < 2) continue;
    strip(g, pts, road.width + 0.55, mix(PAL.grassEdge, PAL.dirt, 0.55));
    strip(g, pts, road.width + 0.16, PAL.dirtEdge);
    strip(g, pts, road.width, PAL.dirt);
    strip(g, pts, road.width * 0.42, road.kind === 'highway' ? PAL.dirtPale : PAL.dirtAlt);
    // Loose stones and ruts. Seeded per road, so they do not crawl frame to
    // frame; the tail of the strip simply stops advancing with `frac`.
    const rr = mulberry32(2024 + road.id.length * 31);
    for (let i = 0; i + 1 < pts.length; i++) {
      const steps = Math.max(
        2,
        Math.round(Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) * 1.2)
      );
      for (let k = 0; k < steps; k++) {
        const t = (k + rr()) / steps;
        const gx = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
        const gy = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
        const off = (rr() - 0.5) * road.width * 1.6;
        rect(g, isoX(gx, gy) + off * 16, isoY(gx, gy) + off * 6, 2 + rr() * 3, 1, PAL.dirtEdge);
      }
    }
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

  /* ---- bridges --------------------------------------------------------- */
  for (const br of scene.map.bridges) {
    const stage = snap.bridges.get(br.id) ?? 0;
    if (!stage) continue;
    drawBridge(g, scene.map.river, br.gx, br.gy, br.span, stage);
  }

  /* ---- the standing wood, straight off its own layer -------------------- */
  g.drawImage(scene.veg.c, scene.lx, scene.ly);

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

  // Only the trees the day is actually touching. Everything still standing is
  // already on the layer that was blitted a moment ago.
  for (const tr of scene.map.trees) {
    const state = snap.trees.get(tr.id);
    if (state === undefined || state === 'standing') continue;
    if (state === 'stump') {
      const sp = scene.pools.stump[Math.abs(tr.seed) % scene.pools.stump.length];
      push(sp, tr.gx, tr.gy);
      continue;
    }
    const p = scene.pools[TREE_POOL[tr.kind] ?? 'oak'];
    const sp = p[Math.abs(tr.seed) % p.length];
    // A tree under the axe leans and shivers a couple of pixels — enough to
    // spot from across the valley, cheap enough to be a whole-pixel offset.
    const sway = Math.round(Math.sin(clock * 3.1 + tr.seed) * 2);
    push(sp, tr.gx, tr.gy, 0, sway);
  }

  for (const site of scene.map.sites) {
    for (const p of site.props) {
      if (!snap.props.has(p.id)) continue;
      const sp = propSprite(scene, p.kind, p.seed, site.accent);
      if (!sp) continue;
      push(sp, p.gx, p.gy);
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

  // Everything from here on moves every frame. The occlusion repair below runs
  // over these first, so that if it ever hits its budget it is the scenery that
  // goes unrepaired, never the crowd.
  const moversFrom = items.length;

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
  }

  items.sort((a, b) => a.depth - b.depth);
  for (const it of items) it.draw(g);

  drawSmoke(g, amb.smoke, wx0, wy0, wx1, wy1, sky.night);

  /* ---- blit the world buffer to the viewport --------------------------- */
  g.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, vw, vh);
  ctx.drawImage(f, 0, 0, bw, bh, 0, 0, bw * zoom, bh * zoom);

  /* ---- the sky, over the finished frame -------------------------------- */
  // Deliberately *not* in the world buffer: this is one screen-sized fill
  // rather than one world-sized one, and the crisp pixels underneath are
  // already blitted and safe.
  if (sky.a > 0.002) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = sky.a;
    ctx.fillStyle = sky.css;
    ctx.fillRect(0, 0, vw, vh);
    ctx.restore();
  }
  if (sky.lift > 0.004) {
    // A wash of low sun (or the first grey of the morning) off the horizon.
    const cool = snap.t < 12;
    const grad = ctx.createLinearGradient(0, 0, 0, vh);
    grad.addColorStop(0, cool ? 'rgba(126,158,214,1)' : 'rgba(255,180,99,1)');
    grad.addColorStop(1, cool ? 'rgba(126,158,214,0)' : 'rgba(255,180,99,0)');
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = sky.lift;
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, vw, vh);
    ctx.restore();
  }
  if (halos.length && sky.lamps > 0.02) {
    const sp = glowSprite(scene);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    for (const h of halos) {
      const sx = (h.x - cx) * zoom;
      const sy = (h.y - cy) * zoom;
      const r = h.r * zoom;
      if (sx + r < 0 || sx - r > vw || sy + r < 0 || sy - r > vh) continue;
      ctx.globalAlpha = h.a;
      ctx.drawImage(sp, sx - r, sy - r, r * 2, r * 2);
    }
    ctx.restore();
  }
}

function drawBridge(
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
