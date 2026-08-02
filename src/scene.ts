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
 *   rebuilt every frame  roads clipped to their built fraction, bridges by
 *                        stage, and one depth-sorted sprite pass over trees,
 *                        stumps, scatter, site dressing and buildings at their
 *                        current progress.
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
}

export interface Ambient {
  bots: Bot[];
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

export interface GenesisScene {
  map: GenesisMap;
  /** Baked terrain + river, and where its top-left sits in world pixels. */
  layer: HTMLCanvasElement;
  lx: number;
  ly: number;
  surround: HTMLCanvasElement;
  frame: HTMLCanvasElement;
  pools: Record<string, Sprite[]>;
  extra: Map<string, Sprite>;
  structs: Map<string, { key: string; sp: StructureSprite }>;
  roadGeo: Map<string, RoadGeo>;
  treeById: Map<string, TreeSpec>;
  siteProps: Map<string, { p: PropSpec; accent: string }>;
  /** World-pixel extent of the map itself (not the padded layer). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
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
  for (const r of map.roads) roadGeo.set(r.id, cumulative(r.pts));
  const treeById = new Map<string, TreeSpec>();
  for (const t of map.trees) treeById.set(t.id, t);
  const siteProps = new Map<string, { p: PropSpec; accent: string }>();
  for (const s of map.sites) for (const p of s.props) siteProps.set(p.id, { p, accent: s.accent });

  return {
    map,
    layer,
    lx,
    ly,
    surround: buildForestPattern(),
    frame: document.createElement('canvas'),
    pools: makePools(),
    extra: new Map(),
    structs: new Map(),
    roadGeo,
    treeById,
    siteProps,
    x0,
    y0,
    x1,
    y1,
  };
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

function propSprite(scene: GenesisScene, kind: string, seed: number, accent: string): Sprite | null {
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
  const key = `${b.id}:${progress.toFixed(2)}`;
  const hit = scene.structs.get(b.id);
  if (hit && hit.key === key) return hit.sp;
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
    lit: false,
    seed: b.seed,
  });
  // One entry per building: the old progress step is never coming back except
  // on a scrub, where rebuilding it costs a fraction of a millisecond.
  scene.structs.set(b.id, { key, sp });
  return sp;
}

/* ------------------------------ ambient life ----------------------------- */

const BOT_COLORS = ['#ef7f93', '#63c9a8', '#9b8fe8', '#f0c75e', '#6cc4d9', '#e98fc3', '#f5a25d'];
const BOT_SPEED = 1.3; // tiles per second
const WALK_SPEED = 1.05;

export function makeAmbient(pace = 1): Ambient {
  return {
    bots: [],
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

function siteTasks(scene: GenesisScene, site: SiteSpec, snap: WorldSnapshot): Task[] {
  const out: Task[] = [];
  // Choppers first — a tree coming down is the most legible bit of work there
  // is, so it should never be the job that goes unstaffed.
  for (const b of site.buildings) {
    for (const id of b.clears) {
      if (snap.trees.get(id) !== 'felling') continue;
      const tr = scene.treeById.get(id);
      if (tr) out.push({ gx: tr.gx, gy: tr.gy, action: 'work', ygx: tr.gx, ygy: tr.gy });
    }
  }
  for (const b of site.buildings) {
    const st = snap.buildings.get(b.id);
    if (!st || st.status === 'unplanned' || st.status === 'done') continue;
    out.push({ gx: b.gx, gy: b.gy, action: 'work', ygx: b.gx, ygy: b.gy });
    out.push({
      gx: b.gx,
      gy: b.gy,
      action: 'carry',
      ygx: site.gx + (b.gx - site.gx) * 0.25,
      ygy: site.gy + (b.gy - site.gy) * 0.25,
    });
  }
  return out;
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
  const extra = paceCrew(amb);
  for (const site of scene.map.sites) {
    const founded = snap.founded.has(site.id);
    const want = founded
      ? Math.max(1, Math.min((snap.population.get(site.id) ?? 1) + extra, 8 + extra))
      : 0;
    const mine = amb.bots.filter((b) => b.site === site.id);
    if (mine.length > want) {
      const drop = new Set(mine.slice(want));
      amb.bots = amb.bots.filter((b) => !drop.has(b));
    }
    for (let i = mine.length; i < want; i++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * site.radius * 0.6;
      amb.bots.push({
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
      });
    }
  }
  amb.bots.forEach((b, i) => {
    b.slot = i;
  });

  /* ---- road walkers ---------------------------------------------------- */
  amb.walkers = amb.walkers.filter((w) => (snap.roads.get(w.roadId) ?? 0) > 0.5);
  for (const road of scene.map.roads) {
    const frac = snap.roads.get(road.id) ?? 0;
    if (frac <= 0.5) continue;
    const want = road.kind === 'highway' ? 2 : 1;
    const have = amb.walkers.filter((w) => w.roadId === road.id).length;
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
    const crew = amb.bots.filter((b) => b.site === site.id);
    if (!crew.length) continue;
    const tasks = siteTasks(scene, site, snap);

    crew.forEach((bot, i) => {
      bot.phase += dt * rate;
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
    const road = scene.map.roads.find((r) => r.id === w.roadId);
    if (!road) continue;
    const geo = scene.roadGeo.get(road.id)!;
    const end = geo.len * (snap.roads.get(road.id) ?? 0);
    w.phase += dt * rate;
    w.s += WALK_SPEED * rate * dt * w.dir;
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

/* -------------------------------- rendering ------------------------------ */

interface Item {
  depth: number;
  draw: (c: Ctx) => void;
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
      poly(g, [
        [hx + 1, hy - 12],
        [hx + 8, hy - 9.5],
        [hx + 1, hy - 7.5],
      ], '#63c9a8');
    }
  }

  /* ---- bridges --------------------------------------------------------- */
  for (const br of scene.map.bridges) {
    const stage = snap.bridges.get(br.id) ?? 0;
    if (!stage) continue;
    drawBridge(g, scene.map.river, br.gx, br.gy, br.span, stage);
  }

  /* ---- one depth-sorted pass over everything that stands up ------------ */
  const items: Item[] = [];
  const push = (sp: Sprite, gx: number, gy: number, dy = 0, dx = 0) => {
    const x = isoX(gx, gy);
    const y = isoY(gx, gy);
    if (!inView(x, y)) return;
    const bx = Math.round(x - sp.ox + dx);
    const by = Math.round(y - sp.oy + dy);
    items.push({ depth: y, draw: (c) => c.drawImage(sp.c, bx, by) });
  };

  for (const tr of scene.map.trees) {
    const state = snap.trees.get(tr.id) ?? 'standing';
    if (state === 'stump') {
      const sp = scene.pools.stump[Math.abs(tr.seed) % scene.pools.stump.length];
      push(sp, tr.gx, tr.gy);
      continue;
    }
    const p = scene.pools[TREE_POOL[tr.kind] ?? 'oak'];
    const sp = p[Math.abs(tr.seed) % p.length];
    if (state === 'felling') {
      // A tree under the axe leans and shivers a couple of pixels — enough to
      // spot from across the valley, cheap enough to be a whole-pixel offset.
      const sway = Math.round(Math.sin(clock * 3.1 + tr.seed) * 2);
      push(sp, tr.gx, tr.gy, 0, sway);
    } else {
      push(sp, tr.gx, tr.gy);
    }
  }

  for (const p of scene.map.scatter) {
    const sp = propSprite(scene, p.kind, p.seed, '#63c9a8');
    if (sp) push(sp, p.gx, p.gy);
  }

  for (const site of scene.map.sites) {
    for (const p of site.props) {
      if (!snap.props.has(p.id)) continue;
      const sp = propSprite(scene, p.kind, p.seed, site.accent);
      if (sp) push(sp, p.gx, p.gy);
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
      items.push({ depth: y, draw: (c) => c.drawImage(sp.c, bx, by) });
    }
  }

  for (const w of amb.wheels) {
    if (!inView(w.x, w.y)) continue;
    const wx = Math.round(w.x);
    const wy = Math.round(w.y);
    items.push({ depth: w.y + 6, draw: (c) => drawWheel(c, wx, wy, clock) });
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
    const { color, faceRight, phase } = w;
    items.push({ depth: y + 1, draw: (c) => drawBot(c, px, py, color, faceRight, 'walk', phase) });
  }

  items.sort((a, b) => a.depth - b.depth);
  for (const it of items) it.draw(g);

  drawSmoke(g, amb.smoke, wx0, wy0, wx1, wy1);

  /* ---- blit the world buffer to the viewport --------------------------- */
  g.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, vw, vh);
  ctx.drawImage(f, 0, 0, bw, bh, 0, 0, bw * zoom, bh * zoom);
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
    poly(ctx, [corner(-half, -depth), corner(half, -depth), corner(half, depth), corner(-half, depth)], PAL.woodDark);
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
      poly(ctx, [
        [a[0], a[1] - 5],
        [b[0], b[1] - 5],
        [b[0], b[1] - 3.5],
        [a[0], a[1] - 3.5],
      ], PAL.woodLight);
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
  wy1: number
): void {
  for (const p of smoke) {
    const a = p.age;
    const r = 2 + a * 2.2;
    const px = Math.round(p.x + Math.sin(a * 1.7 + p.drift) * 3 + a * 2.2);
    const py = Math.round(p.y - a * 9);
    if (px + r < wx0 || px - r > wx1 || py + r < wy0 || py - r > wy1) continue;
    ctx.globalAlpha = Math.max(0, 1 - a / 3.6) * 0.8;
    ctx.fillStyle = a < 1 ? '#ffffff' : a < 2.4 ? '#f1ece2' : '#e4e0da';
    const ri = Math.round(r);
    for (let k = -ri; k <= ri; k++) {
      const w = Math.round(Math.sqrt(Math.max(0, r * r - k * k)) * 2);
      if (w > 0) ctx.fillRect(px - Math.round(w / 2), py + k, w, 1);
    }
    ctx.globalAlpha = 1;
  }
}
