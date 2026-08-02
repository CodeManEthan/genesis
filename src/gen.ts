/**
 * Genesis — procedural map generation.
 *
 *   generateMap(seed, scale = 1) -> GenesisMap
 *
 * Pure, deterministic, DOM-free. Every random draw comes from mulberry32 in
 * types.ts; no Date, no Math.random. Same seed and scale => byte-identical
 * JSON.
 *
 * `scale` (0.25 .. 4) is the pace control: it says how much gets BUILT in a
 * day, never how fast the clock runs. See the SUBSET STABILITY note further
 * down — a smaller scale is a strict prefix of a larger one.
 *
 * GENERATION ORDER (each stage only reads the stages above it):
 *   bounds -> river -> town roster -> accents/names -> road network
 *   (append-only tree, A* routed) -> bridges -> chunks/biomes -> buildings ->
 *   trees -> clears -> wild scatter -> site dressing -> trim to scale.
 *
 * ── COORDINATE SPACE ──────────────────────────────────────────────────────
 * All planning happens in screen-aligned (u, v): u = gx - gy, v = gx + gy.
 * That is the space `bounds`/`content`/`chunks` are authored in, and the space
 * the vale renderer compares `site.radius` against (scene.ts computes
 * hypot(du, dv) / radius). So every distance in this file — site radii, river
 * clearance, road/tree spacing — is a u/v distance, which is sqrt(2) times a
 * raw tile distance. Only at the very end do points convert to tile space via
 * uv(u, v) for Vec2 fields.
 *
 * A building of art width `w` covers w/TW tiles per side, which in u/v is a
 * diamond whose circumradius is exactly w/TW. That is `fpR()` below, and it is
 * what every footprint-overlap and plot-clearing test uses.
 */

import {
  TW,
  mulberry32,
  uv,
  type BridgeSpec,
  type BuildingSpec,
  type Biome,
  type Chunk,
  type GenesisMap,
  type PropSpec,
  type RoadSpec,
  type RoofStyle,
  type SiteSpec,
  type StructureRole,
  type TreeKind,
  type TreeSpec,
  type Vec2,
} from './types.ts';
import { townNames, valleyName } from './names.ts';

/* ========================================================================== */
/*  geometry helpers — all in u/v space                                       */
/* ========================================================================== */

/** A point in screen-aligned u/v space. */
type Pt = [number, number];

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** Footprint circumradius in u/v for a building of art width `w`. */
const fpR = (w: number) => w / TW;

function segDist(p: Pt, a: Pt, b: Pt): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy || 1;
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
}

function polyDist(p: Pt, line: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const d = segDist(p, line[i], line[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

/** Nearest distance plus the unit tangent of the nearest segment. */
function polyNear(p: Pt, line: Pt[]): { d: number; tu: number; tv: number } {
  let best = Infinity;
  let bi = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const d = segDist(p, line[i], line[i + 1]);
    if (d < best) {
      best = d;
      bi = i;
    }
  }
  const dx = line[bi + 1][0] - line[bi][0];
  const dy = line[bi + 1][1] - line[bi][1];
  const l = Math.hypot(dx, dy) || 1;
  return { d: best, tu: dx / l, tv: dy / l };
}

/** Proper segment intersection; null when they miss or are parallel. */
function segInt(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r0 = b[0] - a[0];
  const r1 = b[1] - a[1];
  const s0 = d[0] - c[0];
  const s1 = d[1] - c[1];
  const den = r0 * s1 - r1 * s0;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s1 - (c[1] - a[1]) * s0) / den;
  const u2 = ((c[0] - a[0]) * r1 - (c[1] - a[1]) * r0) / den;
  if (t < 0 || t > 1 || u2 < 0 || u2 > 1) return null;
  return [a[0] + r0 * t, a[1] + r1 * t];
}

/** Every point where polyline A crosses polyline B. */
function crossings(a: Pt[], b: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      const p = segInt(a[i], a[i + 1], b[j], b[j + 1]);
      if (p) out.push(p);
    }
  }
  // Merge near-duplicates (a crossing exactly on a shared vertex).
  const merged: Pt[] = [];
  for (const p of out) {
    if (merged.some((q) => dist(p, q) < 0.9)) continue;
    merged.push(p);
  }
  return merged;
}

function cumulative(line: Pt[]): number[] {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + dist(line[i - 1], line[i]));
  return cum;
}

function pointAtS(line: Pt[], cum: number[], s: number): Pt {
  const total = cum[cum.length - 1];
  const q = clamp(s, 0, total);
  let i = 1;
  while (i < cum.length - 1 && cum[i] < q) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const t = (q - cum[i - 1]) / seg;
  return [lerp(line[i - 1][0], line[i][0], t), lerp(line[i - 1][1], line[i][1], t)];
}

/** Even arclength resample; endpoints preserved. */
function resample(line: Pt[], spacing: number): Pt[] {
  if (line.length < 2) return line.slice();
  const cum = cumulative(line);
  const total = cum[cum.length - 1];
  const n = Math.max(1, Math.round(total / spacing));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) out.push(pointAtS(line, cum, (total * i) / n));
  return out;
}

/** Resample to an exact point count. */
function resampleN(line: Pt[], n: number): Pt[] {
  const cum = cumulative(line);
  const total = cum[cum.length - 1];
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) out.push(pointAtS(line, cum, (total * i) / (n - 1)));
  return out;
}

/** Chaikin corner cutting; endpoints pinned. */
function chaikin(line: Pt[], passes: number): Pt[] {
  let cur = line;
  for (let p = 0; p < passes; p++) {
    if (cur.length < 3) break;
    const next: Pt[] = [cur[0]];
    for (let i = 0; i + 1 < cur.length; i++) {
      const a = cur[i];
      const b = cur[i + 1];
      next.push([lerp(a[0], b[0], 0.25), lerp(a[1], b[1], 0.25)]);
      next.push([lerp(a[0], b[0], 0.75), lerp(a[1], b[1], 0.75)]);
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

/** Douglas-Peucker. */
function simplify(line: Pt[], eps: number): Pt[] {
  if (line.length < 3) return line.slice();
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i + 1 < line.length; i++) {
    const d = segDist(line[i], line[0], line[line.length - 1]);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [line[0], line[line.length - 1]];
  const left = simplify(line.slice(0, idx + 1), eps);
  const right = simplify(line.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

/**
 * Drop near-duplicate vertices and split any over-long segment, so control
 * points land every ~2-3 units without moving the line. Straight bridge runs
 * stay straight — subdividing a straight segment is a no-op geometrically.
 */
function densify(line: Pt[], maxSeg: number, minSeg: number): Pt[] {
  const kept: Pt[] = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const last = kept[kept.length - 1];
    if (dist(line[i], last) < minSeg && i < line.length - 1) continue;
    kept.push(line[i]);
  }
  if (kept.length > 2 && dist(kept[kept.length - 1], kept[kept.length - 2]) < minSeg) {
    kept.splice(kept.length - 2, 1);
  }
  const out: Pt[] = [kept[0]];
  for (let i = 1; i < kept.length; i++) {
    const d = dist(kept[i - 1], kept[i]);
    const n = Math.max(1, Math.ceil(d / maxSeg));
    for (let k = 1; k <= n; k++) {
      out.push([
        lerp(kept[i - 1][0], kept[i][0], k / n),
        lerp(kept[i - 1][1], kept[i][1], k / n),
      ]);
    }
  }
  return out;
}

/** Relax interior turn angles so a polyline never kinks harder than `maxDeg`. */
function relaxTurns(line: Pt[], maxDeg: number, passes: number): Pt[] {
  const cos = Math.cos((maxDeg * Math.PI) / 180);
  const out = line.map((p) => [p[0], p[1]] as Pt);
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 1; i + 1 < out.length; i++) {
      const ax = out[i][0] - out[i - 1][0];
      const ay = out[i][1] - out[i - 1][1];
      const bx = out[i + 1][0] - out[i][0];
      const by = out[i + 1][1] - out[i][1];
      const la = Math.hypot(ax, ay) || 1;
      const lb = Math.hypot(bx, by) || 1;
      const dot = (ax * bx + ay * by) / (la * lb);
      if (dot >= cos) continue;
      const mx = (out[i - 1][0] + out[i + 1][0]) / 2;
      const my = (out[i - 1][1] + out[i + 1][1]) / 2;
      out[i][0] = lerp(out[i][0], mx, 0.5);
      out[i][1] = lerp(out[i][1], my, 0.5);
    }
  }
  return out;
}

/* ========================================================================== */
/*  palettes and tables                                                       */
/* ========================================================================== */

/** Pastel gems, same family as GEM_COLORS in src/data/islands.ts. */
const ACCENTS = [
  '#ef7f93', '#f5a25d', '#f0c75e', '#6cc4d9', '#9b8fe8', '#63c9a8', '#e98fc3',
  '#7fb2ef', '#d9a066', '#8fd68f', '#c78ff0', '#5fbfa8', '#efb0a0', '#a8c96e',
];

/** One landmark per site, rotated so no two towns share a silhouette. */
const LANDMARK_ROLES: StructureRole[] = [
  'hall', 'mill', 'chapel', 'granary', 'tower', 'smithy', 'barn',
];

/**
 * Weighted pool for ordinary plots. Chapels and towers are deliberately absent
 * — they are landmark silhouettes, and three chapels in one hamlet reads as a
 * bug rather than as variety.
 */
const COMMON_ROLES: StructureRole[] = [
  'cottage', 'cottage', 'cottage', 'cottage', 'house', 'house', 'house',
  'store', 'store', 'workshop', 'workshop', 'shed', 'shed', 'barn',
  'granary', 'smithy', 'mill',
];

const LABELS: Record<StructureRole, string[]> = {
  homestead: ['The First House'],
  cottage: [
    'Wren Row', 'Larkin Cottage', 'The Old Cottage', 'Rushlight Cottage',
    'Hedgerow Cottage', 'Sparrow Cottage', 'The Little House', 'Pippin Cottage',
  ],
  house: [
    'Glebe House', 'Fern House', 'The Long House', 'Elmer House',
    'The Reeve’s House', 'Quarry House', 'Bell House',
  ],
  hall: ['The Moot Hall', 'The Guildhall', 'The Long Hall', 'The Assembly'],
  barn: ['The Long Barn', 'The Great Barn', 'Barnside', 'The Tithe Barn'],
  workshop: ['The Workshop', 'The Joinery', 'The Wheelwright', 'The Turnery'],
  store: ['The Provisioner', 'Market House', 'The Corner Store', 'The Dry Goods'],
  chapel: ['The Chapel', 'The Little Chapel', 'St Bride’s', 'The Chantry'],
  tower: ['The Watchtower', 'The Bell Tower', 'The Lookout', 'The Beacon'],
  mill: ['The Mill', 'Millhouse', 'The Old Mill', 'The Water Mill'],
  granary: ['The Granary', 'The Corn Store', 'The Grain Loft', 'Harvest Store'],
  smithy: ['The Smithy', 'The Forge', 'Anvil Yard', 'The Farrier'],
  shed: ['The Woodshed', 'The Tool Shed', 'The Lean-To', 'The Cart Shed'],
};

const THATCH_ROLES = new Set<StructureRole>(['cottage', 'barn', 'shed', 'homestead']);

/** Flavour dressing that shows up as a town matures. */
const FLAVOUR_PROPS = ['crop', 'haystack', 'crates', 'barrels', 'cart', 'shed'];

const pick = <T,>(rng: () => number, list: readonly T[]): T =>
  list[Math.min(list.length - 1, Math.floor(rng() * list.length))];

/* ========================================================================== */
/*  river                                                                     */
/* ========================================================================== */

/**
 * A meandering edge-to-edge river. Three seeded orientations (N->S, W->E, or a
 * lazy diagonal) so consecutive days do not feel like the same valley. The
 * meander amplitude is tapered to zero at both ends so the mouth sits exactly
 * on the bounds edge, and turn angles are relaxed to keep the water lazy.
 */
function makeRiver(rng: () => number, b: { u0: number; v0: number; u1: number; v1: number }): Pt[] {
  // Cast a line through a point near the middle of the map out to both edges,
  // so the water always bisects the valley and at least one road has to cross.
  // The heading bucket gives the day its character: N->S, W->E, or a diagonal.
  const bucket = Math.floor(rng() * 3);
  const theta =
    bucket === 0
      ? lerp(Math.PI * 0.34, Math.PI * 0.66, rng()) // mostly along v (north-south)
      : bucket === 1
        ? lerp(-Math.PI * 0.16, Math.PI * 0.16, rng()) // mostly along u (west-east)
        : (rng() < 0.5 ? 1 : -1) * lerp(Math.PI * 0.19, Math.PI * 0.31, rng()); // lazy diagonal
  // Offset from dead centre so the founding town has room to sit clear of the
  // water, but never so far that the river stops splitting the valley.
  const ca = rng() * Math.PI * 2;
  const cr = lerp(7, 15, rng());
  const c: Pt = [Math.cos(ca) * cr, Math.sin(ca) * cr];
  const dir: Pt = [Math.cos(theta), Math.sin(theta)];
  /** Distance from c to the bounds rectangle along +dir. */
  const reach = (sign: number): number => {
    let t = Infinity;
    const du = dir[0] * sign;
    const dv = dir[1] * sign;
    if (Math.abs(du) > 1e-6) t = Math.min(t, ((du > 0 ? b.u1 : b.u0) - c[0]) / du);
    if (Math.abs(dv) > 1e-6) t = Math.min(t, ((dv > 0 ? b.v1 : b.v0) - c[1]) / dv);
    return t;
  };
  const start: Pt = [c[0] - dir[0] * reach(-1), c[1] - dir[1] * reach(-1)];
  const end: Pt = [c[0] + dir[0] * reach(1), c[1] + dir[1] * reach(1)];

  const dirU = end[0] - start[0];
  const dirV = end[1] - start[1];
  const len = Math.hypot(dirU, dirV) || 1;
  const perp: Pt = [-dirV / len, dirU / len];

  const amp1 = 5 + rng() * 5;
  const amp2 = 2 + rng() * 3;
  const ph1 = 1 + rng() * 1.6;
  const ph2 = 2.4 + rng() * 2.2;
  const off1 = rng() * Math.PI * 2;
  const off2 = rng() * Math.PI * 2;

  const RAW = 22;
  let pts: Pt[] = [];
  for (let i = 0; i < RAW; i++) {
    const t = i / (RAW - 1);
    const taper = Math.sin(Math.PI * t);
    const lat =
      taper *
      (amp1 * Math.sin(t * Math.PI * ph1 + off1) +
        amp2 * Math.sin(t * Math.PI * ph2 + off2) +
        (rng() - 0.5) * 2.4);
    let u = lerp(start[0], end[0], t) + perp[0] * lat;
    let v = lerp(start[1], end[1], t) + perp[1] * lat;
    if (i > 0 && i < RAW - 1) {
      u = clamp(u, b.u0 + 1.5, b.u1 - 1.5);
      v = clamp(v, b.v0 + 1.5, b.v1 - 1.5);
    }
    pts.push([u, v]);
  }

  pts = relaxTurns(pts, 34, 8);
  pts = chaikin(pts, 1);
  const n = 10 + Math.floor(rng() * 5); // 10..14 control points
  pts = resampleN(pts, n);
  // Pin the mouths back onto the bounds edge after resampling.
  pts[0] = start;
  pts[pts.length - 1] = end;
  return relaxTurns(pts, 40, 3);
}

/**
 * Which bank of the river a point sits on.
 *
 * The nearest-segment normal lies about this near concave bends, and a wrong
 * answer means the spanning tree thinks two towns share a bank and the valley
 * ends up with no bridge. So instead the river is closed into a polygon by
 * walking the bounds rectangle from its mouth back to its source, and the test
 * becomes an exact point-in-polygon.
 */
function makeBankTest(river: Pt[], b: { u0: number; v0: number; u1: number; v1: number }): (p: Pt) => number {
  const du = b.u1 - b.u0 || 1;
  const dv = b.v1 - b.v0 || 1;
  /** Perimeter parameter 0..4, counter-clockwise from (u0, v0). */
  const perim = (p: Pt): number => {
    const dLeft = Math.abs(p[0] - b.u0);
    const dRight = Math.abs(p[0] - b.u1);
    const dBot = Math.abs(p[1] - b.v0);
    const dTop = Math.abs(p[1] - b.v1);
    const m = Math.min(dLeft, dRight, dBot, dTop);
    if (m === dBot) return (p[0] - b.u0) / du;
    if (m === dRight) return 1 + (p[1] - b.v0) / dv;
    if (m === dTop) return 2 + (b.u1 - p[0]) / du;
    return 3 + (b.v1 - p[1]) / dv;
  };
  const corner = (k: number): Pt =>
    k === 0 ? [b.u0, b.v0] : k === 1 ? [b.u1, b.v0] : k === 2 ? [b.u1, b.v1] : [b.u0, b.v1];

  const poly = river.slice();
  let s = perim(river[river.length - 1]);
  const target = perim(river[0]);
  for (let guard = 0; guard < 5; guard++) {
    const next = Math.floor(s) + 1;
    // Stop once the walk would step past the source.
    const wrapped = target > s ? target : target + 4;
    if (next >= wrapped) break;
    poly.push(corner(next % 4));
    s = next;
  }

  return (p: Pt): number => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const yi = poly[i][1];
      const yj = poly[j][1];
      if (yi > p[1] !== yj > p[1]) {
        const x = ((poly[j][0] - poly[i][0]) * (p[1] - yi)) / (yj - yi) + poly[i][0];
        if (p[0] < x) inside = !inside;
      }
    }
    return inside ? 1 : -1;
  };
}

/* ========================================================================== */
/*  A* road router                                                            */
/* ========================================================================== */

interface RouteGrid {
  u0: number;
  v0: number;
  w: number;
  h: number;
  riverD: Float32Array;
  riverTu: Float32Array;
  riverTv: Float32Array;
}

function buildRouteGrid(content: { u0: number; v0: number; u1: number; v1: number }, river: Pt[]): RouteGrid {
  const u0 = Math.ceil(content.u0);
  const v0 = Math.ceil(content.v0);
  const w = Math.floor(content.u1) - u0 + 1;
  const h = Math.floor(content.v1) - v0 + 1;
  const riverD = new Float32Array(w * h);
  const riverTu = new Float32Array(w * h);
  const riverTv = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const near = polyNear([u0 + i, v0 + j], river);
      const k = j * w + i;
      riverD[k] = near.d;
      riverTu[k] = near.tu;
      riverTv[k] = near.tv;
    }
  }
  return { u0, v0, w, h, riverD, riverTu, riverTv };
}

/** Cost of stepping into a river cell: cheap across, ruinous along. */
const RIVER_ZONE = 2.3;
const riverStepCost = (align: number) => 6 + 110 * align * align;

/** Binary min-heap over (cost, node). */
function makeHeap() {
  const cost: number[] = [];
  const node: number[] = [];
  const push = (c: number, n: number) => {
    cost.push(c);
    node.push(n);
    let i = cost.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cost[p] <= cost[i]) break;
      [cost[p], cost[i]] = [cost[i], cost[p]];
      [node[p], node[i]] = [node[i], node[p]];
      i = p;
    }
  };
  const pop = (): number => {
    const top = node[0];
    const lc = cost.pop() as number;
    const ln = node.pop() as number;
    if (cost.length) {
      cost[0] = lc;
      node[0] = ln;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < cost.length && cost[l] < cost[m]) m = l;
        if (r < cost.length && cost[r] < cost[m]) m = r;
        if (m === i) break;
        [cost[m], cost[i]] = [cost[i], cost[m]];
        [node[m], node[i]] = [node[i], node[m]];
        i = m;
      }
    }
    return top;
  };
  return { push, pop, size: () => cost.length };
}

const DIRS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * Greedy-admissible A* over a 1-unit u/v lattice. River cells are expensive
 * unless the step is near-perpendicular to the water; cells inside a
 * non-endpoint town are heavily (but finitely) penalised so a route always
 * exists even when two exclusion discs pinch a corridor.
 */
function routeRoad(grid: RouteGrid, start: Pt, goal: Pt, avoid: { u: number; v: number; r: number }[]): Pt[] {
  const { w, h, u0, v0 } = grid;
  const idx = (i: number, j: number) => j * w + i;
  const toCell = (p: Pt): number => {
    const i = clamp(Math.round(p[0] - u0), 0, w - 1);
    const j = clamp(Math.round(p[1] - v0), 0, h - 1);
    return idx(i, j);
  };

  // Per-road town penalty field. `avoid[].r` already carries the slack the
  // smoothing passes need, so this is a plain hard core — no graded shoulder.
  // A shoulder reads as the obvious way to centre a road in a narrow corridor,
  // but it turns every tight gap into a toll booth, and A* answers by looping
  // half way round the valley instead.
  const pen = new Float32Array(w * h);
  for (const a of avoid) {
    const i0 = clamp(Math.floor(a.u - a.r - u0), 0, w - 1);
    const i1 = clamp(Math.ceil(a.u + a.r - u0), 0, w - 1);
    const j0 = clamp(Math.floor(a.v - a.r - v0), 0, h - 1);
    const j1 = clamp(Math.ceil(a.v + a.r - v0), 0, h - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(u0 + i - a.u, v0 + j - a.v);
        if (d < a.r) pen[idx(i, j)] += 700;
      }
    }
  }

  const s = toCell(start);
  const g = toCell(goal);
  // Never let the endpoints themselves be walled in.
  pen[s] = 0;
  pen[g] = 0;

  const gScore = new Float64Array(w * h).fill(Infinity);
  const cameFrom = new Int32Array(w * h).fill(-1);
  const closed = new Uint8Array(w * h);
  const gi = g % w;
  const gj = (g - gi) / w;
  const heur = (n: number) => {
    const i = n % w;
    const j = (n - i) / w;
    return Math.hypot(i - gi, j - gj);
  };

  const heap = makeHeap();
  gScore[s] = 0;
  heap.push(heur(s), s);

  while (heap.size()) {
    const cur = heap.pop();
    if (cur === g) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const ci = cur % w;
    const cj = (cur - ci) / w;
    for (const [du, dv] of DIRS) {
      const ni = ci + du;
      const nj = cj + dv;
      if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
      const nb = idx(ni, nj);
      if (closed[nb]) continue;
      const step = du && dv ? Math.SQRT2 : 1;
      let c = step + pen[nb] * step;
      if (grid.riverD[nb] < RIVER_ZONE) {
        const align = Math.abs((du * grid.riverTu[nb] + dv * grid.riverTv[nb]) / step);
        c += riverStepCost(align) * step;
      }
      const tentative = gScore[cur] + c;
      if (tentative < gScore[nb]) {
        gScore[nb] = tentative;
        cameFrom[nb] = cur;
        heap.push(tentative + heur(nb), nb);
      }
    }
  }

  const path: Pt[] = [];
  let n = g;
  if (gScore[g] === Infinity) return [start, goal];
  while (n !== -1) {
    const i = n % w;
    const j = (n - i) / w;
    path.push([u0 + i, v0 + j]);
    if (n === s) break;
    n = cameFrom[n];
  }
  path.reverse();
  return path;
}

/* ========================================================================== */
/*  bridges                                                                   */
/* ========================================================================== */

/**
 * Straighten a road locally wherever it meets the water so the crossing reads
 * as a deliberate bridge rather than a wobble. The caller re-derives the
 * crossings from the FINAL polyline, so every intersection is guaranteed to
 * carry a bridge no matter what this pass does.
 */
function bridgeRoad(pts: Pt[], river: Pt[]): Pt[] {
  let line = pts.map((p) => [p[0], p[1]] as Pt);

  for (let guard = 0; guard < 4; guard++) {
    const hits = crossings(line, river);
    if (!hits.length) break;
    const cum = cumulative(line);
    const total = cum[cum.length - 1];
    // Arclength of each crossing.
    const marks = hits
      .map((p) => {
        let bs = 0;
        let bd = Infinity;
        for (let i = 0; i + 1 < line.length; i++) {
          const d = segDist(p, line[i], line[i + 1]);
          if (d < bd) {
            bd = d;
            const seg = dist(line[i], line[i + 1]) || 1;
            const t = clamp(
              ((p[0] - line[i][0]) * (line[i + 1][0] - line[i][0]) +
                (p[1] - line[i][1]) * (line[i + 1][1] - line[i][1])) /
                (seg * seg),
              0,
              1
            );
            bs = cum[i] + seg * t;
          }
        }
        return { p, s: bs };
      })
      .sort((a, b) => a.s - b.s);

    let changed = false;
    const out: Pt[] = [];
    let consumedTo = -1;
    for (let m = 0; m < marks.length; m++) {
      const { s } = marks[m];
      const prevS = m > 0 ? marks[m - 1].s : -Infinity;
      const nextS = m + 1 < marks.length ? marks[m + 1].s : Infinity;
      const back = Math.min(4.0, s, (s - prevS) / 2);
      const fwd = Math.min(4.0, total - s, (nextS - s) / 2);
      if (back < 0.8 || fwd < 0.8) continue;
      // Replace the wobbly stretch either side of the water with one straight
      // run. Keeping the real polyline points a and b keeps the road
      // continuous; the true crossing is re-derived from the final geometry
      // below, so the bridge always lands on the water.
      const a = pointAtS(line, cum, s - back);
      const b = pointAtS(line, cum, s + fwd);
      for (let i = 0; i < line.length; i++) {
        if (cum[i] < s - back && cum[i] > consumedTo) out.push(line[i]);
      }
      out.push(a);
      out.push(b);
      consumedTo = s + fwd;
      changed = true;
    }
    if (!changed) break;
    for (let i = 0; i < line.length; i++) {
      if (cum[i] > consumedTo) out.push(line[i]);
    }
    // Keep true endpoints.
    if (dist(out[0], line[0]) > 1e-6) out.unshift(line[0]);
    if (dist(out[out.length - 1], line[line.length - 1]) > 1e-6) out.push(line[line.length - 1]);
    line = out.filter((p, i) => i === 0 || dist(p, out[i - 1]) > 1e-6);
  }

  return line;
}

/**
 * Carry a road from the town rim on into the green.
 *
 * A road that stops at the rim reads as a dead end; carried through, a town
 * with two connections gets one continuous street. The extension is a
 * quadratic Bezier that leaves the rim along the road's own heading and bends
 * onto the radial, so it joins without a kink, and it stops `stopR` short of
 * the exact centre so the founding house or the landmark is never paved over.
 */
function extendIntoTown(line: Pt[], centre: Pt, stopR: number, atStart: boolean): Pt[] {
  const n = line.length;
  if (n < 2) return line;
  const tip = atStart ? line[0] : line[n - 1];
  const nb = atStart ? line[1] : line[n - 2];
  const tx = tip[0] - nb[0];
  const ty = tip[1] - nb[1];
  const tl = Math.hypot(tx, ty) || 1;
  const heading: Pt = [tx / tl, ty / tl]; // continues on into the town

  const rx = tip[0] - centre[0];
  const ry = tip[1] - centre[1];
  const rl = Math.hypot(rx, ry) || 1;
  const stop: Pt = [centre[0] + (rx / rl) * stopR, centre[1] + (ry / rl) * stopR];

  const span = dist(tip, stop);
  if (span < 0.8) return line;
  const ctrl: Pt = [tip[0] + heading[0] * span * 0.45, tip[1] + heading[1] * span * 0.45];

  const steps = Math.max(2, Math.round(span / 1.4));
  const ext: Pt[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const m = 1 - t;
    let p: Pt = [
      m * m * tip[0] + 2 * m * t * ctrl[0] + t * t * stop[0],
      m * m * tip[1] + 2 * m * t * ctrl[1] + t * t * stop[1],
    ];
    // The control point can nose the arc inside the keep-out; push it back out.
    const d = dist(p, centre);
    if (d < stopR) {
      p = [centre[0] + ((p[0] - centre[0]) / (d || 1)) * stopR, centre[1] + ((p[1] - centre[1]) / (d || 1)) * stopR];
    }
    ext.push(p);
  }
  return atStart ? [...ext.reverse(), ...line] : [...line, ...ext];
}

/* ========================================================================== */
/*  the generator                                                             */
/* ========================================================================== */

/* ========================================================================== */
/*  content scale                                                             */
/* ========================================================================== */

/**
 * `scale` says how much gets BUILT in a day, not how fast the day runs. A
 * bigger scale means more towns and more plots per town; the land itself —
 * bounds, river, chunks, trees, scatter — never changes.
 *
 * SUBSET STABILITY. For one seed, the world at a smaller scale is a strict
 * prefix of the world at a larger one: same terrain, same names, same
 * positions, with sites, roads and per-site buildings only ever APPENDED. That
 * is what lets the pace control be a live knob rather than a reroll.
 *
 * It is bought by generating the full scale-4 roster every time, in an order
 * that never consults `scale`, and truncating at the end. Everything that
 * shapes the land — tree clearance, felling, biome cascade — is computed
 * against that full roster, so it cannot shift when the roster is trimmed.
 */
const SCALE_MIN = 0.25;
const SCALE_MAX = 4;

/** Town-count multiplier. Tuned to ~2 at 0.25x, ~3-4 at 0.5x, ~9-11 at 2x, ~13-16 at 4x. */
const siteFactor = (s: number) => (s <= 1 ? Math.pow(s, 0.8) : Math.pow(s, 0.585));
/** Plots-per-town multiplier — deliberately gentler than the town count. */
const buildFactor = (s: number) => (s <= 1 ? Math.pow(s, 0.75) : Math.pow(s, 0.29));

export function generateMap(seed: number, scale = 1): GenesisMap {
  const rng = mulberry32(seed >>> 0);
  const S = clamp(scale, SCALE_MIN, SCALE_MAX);

  const content = { u0: -34, v0: -40, u1: 34, v1: 40 };
  const bounds = { u0: -40, v0: -46, u1: 40, v1: 46 };

  /* ---- river ----------------------------------------------------------- */
  const river = makeRiver(rng, bounds);
  const riverWidth = 0.95;
  // Minimum clearance from the river centreline to a town centre. A town also
  // has to keep its whole clearing off the water (radius + 1.2), otherwise a
  // road can start life already on the far bank and the crossing vanishes.
  const RIVER_CLEAR = 4.2;

  /* ---- sites ----------------------------------------------------------- */
  interface Site {
    id: string;
    name: string;
    u: number;
    v: number;
    r: number;
    accent: string;
  }
  const sites: Site[] = [];
  // The day's baseline town count. Everything scale-related is expressed as a
  // multiple of this, and it is drawn from the seed alone, so the roster is
  // identical no matter what scale was asked for.
  const nBase = 5 + Math.floor(rng() * 3); // 5..7

  // sites[0]: the founding homestead, near the middle, off the water.
  {
    let r0 = 7 + rng() * 2;
    let placed: Pt | null = null;
    // Prefer trading a little size for a central position: the founding town
    // should sit near the middle of the valley, not shoved into a corner by a
    // river bend.
    for (let ring = 0; ring < 6 && !placed; ring++) {
      const reach = 6 + ring * 1.1;
      const rTry = Math.max(7, r0 - ring * 0.4);
      for (let t = 0; t < 500; t++) {
        const a = rng() * Math.PI * 2;
        const rad = Math.sqrt(rng()) * reach;
        const p: Pt = [Math.cos(a) * rad, Math.sin(a) * rad];
        if (polyDist(p, river) < Math.max(RIVER_CLEAR, rTry + 1.2)) continue;
        placed = p;
        r0 = rTry;
        break;
      }
    }
    if (!placed) {
      // Insurance: sweep a coarse lattice for the most sheltered spot near the
      // middle. Never leave the founding house standing in the water.
      let best = -Infinity;
      let bestP: Pt = [0, 0];
      for (let u = -12; u <= 12; u += 1.5) {
        for (let v = -12; v <= 12; v += 1.5) {
          const d = polyDist([u, v], river) - Math.hypot(u, v) * 0.2;
          if (d > best) {
            best = d;
            bestP = [u, v];
          }
        }
      }
      placed = bestP;
      r0 = Math.max(7, Math.min(r0, polyDist(bestP, river) - 1.2));
    }
    sites.push({ id: 's0', name: '', u: placed[0], v: placed[1], r: r0, accent: ACCENTS[0] });
  }

  // The rest: rejection sampling, well spaced, off the water, off the edge.
  // At least two towns are pushed onto the far bank, so the day always has a
  // river to bridge rather than a river to look at.
  const bankOf = makeBankTest(river, bounds);
  const homeBank = bankOf([sites[0].u, sites[0].v]);
  const wantFar = nBase >= 6 ? 2 : 1;
  for (let relax = 0; sites.length < nBase && relax < 5; relax++) {
    const gap = 14 - relax;
    for (let i = sites.length; i < nBase; i++) {
      const far = sites.filter((s) => bankOf([s.u, s.v]) !== homeBank).length;
      const slots = nBase - i;
      // The first pass demands the far bank; the second drops the demand so a
      // pinched map still gets its full complement of towns.
      const needFar = slots <= wantFar - far;
      let done = false;
      for (let pass = 0; pass < 2 && !done; pass++) {
        for (let t = 0; t < 3000 && !done; t++) {
          const r = 4.5 + rng() * 3;
          const margin = Math.max(6, r + 2);
          const u = lerp(content.u0 + margin, content.u1 - margin, rng());
          const v = lerp(content.v0 + margin, content.v1 - margin, rng());
          const p: Pt = [u, v];
          if (polyDist(p, river) < Math.max(RIVER_CLEAR, r + 1.2)) continue;
          if (needFar && pass === 0 && bankOf(p) === homeBank) continue;
          let ok = true;
          for (const s of sites) {
            // Keep exclusion discs disjoint so the router always has a corridor.
            if (dist(p, [s.u, s.v]) < Math.max(gap, s.r + r + 3.5)) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
          sites.push({ id: `s${sites.length}`, name: '', u, v, r, accent: '' });
          done = true;
        }
      }
      if (!done) break;
    }
  }

  /* ---- accents, names, and the rest of the world's one-off rolls -------- */
  const pool = ACCENTS.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const usedNames = new Set<string>();
  const names = townNames(rng, sites.length, usedNames);
  const landmarkOffset = Math.floor(rng() * LANDMARK_ROLES.length);
  const scatterTarget = 100 + Math.floor(rng() * 80);
  const valley = valleyName(rng);

  /* ---- the rest of the roster ------------------------------------------ */
  // Frontier holdings beyond the day's baseline. They are drawn last and only
  // ever appended, so trimming the roster for a smaller scale can never move
  // one of the towns above. They infill a little tighter and run a little
  // smaller than the founding towns.
  const rosterMax = clamp(Math.round(nBase * siteFactor(SCALE_MAX)), 2, 16);
  for (let relax = 0; sites.length < rosterMax && relax < 6; relax++) {
    const gap = 12 - relax * 0.8;
    for (let i = sites.length; i < rosterMax; i++) {
      let done = false;
      for (let t = 0; t < 3000 && !done; t++) {
        const r = 4 + rng() * 2;
        const margin = Math.max(6, r + 2);
        const u = lerp(content.u0 + margin, content.u1 - margin, rng());
        const v = lerp(content.v0 + margin, content.v1 - margin, rng());
        const p: Pt = [u, v];
        if (polyDist(p, river) < Math.max(RIVER_CLEAR, r + 1.2)) continue;
        let ok = true;
        for (const s of sites) {
          if (dist(p, [s.u, s.v]) < Math.max(gap, s.r + r + 3)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        sites.push({ id: `s${sites.length}`, name: '', u, v, r, accent: '' });
        done = true;
      }
      if (!done) break;
    }
  }
  // Order each block outward from the founding house. Roster order IS founding
  // order — it decides which towns a small day reaches and which town each road
  // hangs off — so growing outward from the first house both tells the right
  // story and keeps the road network short. Sorting inside the blocks rather
  // than across them means a scale-1 day still gets the well-spaced founding
  // towns rather than a mix of those and the tighter frontier holdings.
  {
    const home: Pt = [sites[0].u, sites[0].v];
    const outward = (a: Site, b: Site) =>
      dist([a.u, a.v], home) - dist([b.u, b.v], home) || a.u - b.u || a.v - b.v;
    const baseline = sites.slice(1, Math.min(nBase, sites.length)).sort(outward);
    const frontier = sites.slice(Math.min(nBase, sites.length)).sort(outward);
    sites.length = 1;
    sites.push(...baseline, ...frontier);
  }
  if (sites.length > names.length) {
    names.push(...townNames(rng, sites.length - names.length, usedNames));
  }
  sites.forEach((s, i) => {
    s.id = `s${i}`;
    s.accent = pool[i % pool.length];
    s.name = names[i];
  });

  /** How many of the roster actually get founded today. */
  const nSites = clamp(Math.round(nBase * siteFactor(S)), 2, sites.length);

  /* ---- road network ---------------------------------------------------- */
  // Every town joins via the NEAREST town founded before it — Prim's rule, but
  // with "already connected" pinned to the roster order rather than to Prim's
  // own visit order. That makes the network append-only by construction: the
  // edge for town i only ever looks at towns below i, so truncating the roster
  // truncates the road list and can never rewire an earlier road.
  //
  // (Textbook Prim is NOT safe here: a frontier holding can be nearer to the
  // tree than a founding town, which reorders the edges and re-parents earlier
  // towns, so the scale-1 road list would stop being a prefix of the scale-4
  // one.)
  const parent = new Array<number>(sites.length).fill(-1);
  const depth = new Array<number>(sites.length).fill(0);
  const edges: [number, number][] = [];
  let loops = 0;
  for (let i = 1; i < sites.length; i++) {
    const p: Pt = [sites[i].u, sites[i].v];
    let best = -1;
    let bd = Infinity;
    let second = -1;
    let sd = Infinity;
    for (let j = 0; j < i; j++) {
      const d = dist(p, [sites[j].u, sites[j].v]);
      if (d < bd) {
        second = best;
        sd = bd;
        best = j;
        bd = d;
      } else if (d < sd) {
        second = j;
        sd = d;
      }
    }
    parent[i] = best;
    depth[i] = depth[best] + 1;
    edges.push([best, i]);
    // A neighbourly second lane, so the network is not a pure tree. Decided
    // per town from its own stream and capped in roster order, both of which
    // keep the append-only property.
    const lrng = mulberry32((seed + i * 7331 + 91) >>> 0);
    if (
      second >= 0 &&
      loops < 2 &&
      sd < 24 &&
      bankOf(p) === bankOf([sites[second].u, sites[second].v]) &&
      lrng() < 0.42
    ) {
      edges.push([second, i]);
      loops++;
    }
  }

  const grid = buildRouteGrid(content, river);
  const roads: RoadSpec[] = [];
  const bridges: BridgeSpec[] = [];
  const roadLines: Pt[][] = [];

  edges.forEach(([a, b], ei) => {
    const A = sites[a];
    const B = sites[b];
    const pa: Pt = [A.u, A.v];
    const pb: Pt = [B.u, B.v];
    const dx = pb[0] - pa[0];
    const dy = pb[1] - pa[1];
    const l = Math.hypot(dx, dy) || 1;
    const start: Pt = [pa[0] + (dx / l) * A.r * 0.85, pa[1] + (dy / l) * A.r * 0.85];
    const goal: Pt = [pb[0] - (dx / l) * B.r * 0.85, pb[1] - (dy / l) * B.r * 0.85];

    const avoid = sites
      .map((s, i) => ({ u: s.u, v: s.v, r: s.r + 1.6, i }))
      .filter((s) => s.i !== a && s.i !== b);

    let line = routeRoad(grid, start, goal, avoid);
    line = simplify(line, 0.55);
    line = resample(line, 2.6);
    line = chaikin(line, 2);
    line = resample(line, 2.6);
    line[0] = start;
    line[line.length - 1] = goal;

    line = densify(bridgeRoad(line, river), 3.0, 0.4);
    // Through-roads. s0 keeps a wider berth because its founding house sits on
    // the exact centre; elsewhere the green is empty and the street can run
    // right in. Bridges and arclength fracs are both derived below, from the
    // final polyline, so the extra length is accounted for automatically.
    line = extendIntoTown(line, pa, a === 0 ? 2.1 : 1.4, true);
    line = extendIntoTown(line, pb, b === 0 ? 2.1 : 1.4, false);

    const kind: RoadSpec['kind'] = a === 0 || b === 0 ? 'highway' : depth[b] <= 2 ? 'lane' : 'track';
    const width = kind === 'highway' ? 0.62 : kind === 'lane' ? 0.5 : 0.4;
    const id = `r${ei}`;
    roads.push({
      id,
      kind,
      pts: line.map((p) => uv(p[0], p[1]) as Vec2),
      width,
      from: A.id,
      to: B.id,
    });
    roadLines.push(line);
    for (const p of crossings(line, river)) {
      bridges.push({
        id: `br${bridges.length}`,
        roadId: id,
        gx: uv(p[0], p[1])[0],
        gy: uv(p[0], p[1])[1],
        span: 4.2,
      });
    }
  });

  // Both ends of edge `ei` are roster indices <= the town it serves, and the
  // edges are emitted in roster order, so the roads a smaller scale keeps are
  // exactly a prefix of this array — and likewise the bridges hung off them.
  const roadCount = edges.filter(([a, b]) => Math.max(a, b) < nSites).length;
  const activeRoads = roads.slice(0, roadCount);
  const activeRoadIds = new Set(activeRoads.map((r) => r.id));
  const activeBridges = bridges.filter((b) => activeRoadIds.has(b.roadId));

  /* ---- chunks / biomes -------------------------------------------------- */
  const chunks: Chunk[] = [];
  const CU = 8;
  const CV = 10;
  const cw = (bounds.u1 - bounds.u0) / CU;
  const ch = (bounds.v1 - bounds.v0) / CV;
  for (let j = 0; j < CV; j++) {
    for (let i = 0; i < CU; i++) {
      const u0 = bounds.u0 + i * cw;
      const v0 = bounds.v0 + j * ch;
      const cu = u0 + cw / 2;
      const cv = v0 + ch / 2;
      const c: Pt = [cu, cv];
      const edge = Math.max(Math.abs(cu) / (bounds.u1 - 2), Math.abs(cv) / (bounds.v1 - 2));
      // Keyed to the baseline towns only. Using the whole scale-4 roster would
      // turn most of the valley into farmland and leave the frontier glades
      // with nothing to fell; keying it to nBase is equally scale-independent
      // and leaves the outer holdings standing in real woodland.
      let nearSite = Infinity;
      for (let k = 0; k < nBase && k < sites.length; k++) {
        nearSite = Math.min(nearSite, dist(c, [sites[k].u, sites[k].v]) - sites[k].r);
      }
      const nearRiver = polyDist(c, river);

      let biome: Biome = 'meadow';
      if (nearRiver < 5.5) biome = 'wetland';
      else if (nearSite < 6) biome = 'farm';
      else if (edge > 0.8) biome = 'forest';
      else if ((i * 7 + j * 13 + (seed % 5)) % 5 === 0) biome = 'forest';

      chunks.push({
        id: `c${i}_${j}`,
        u0,
        v0,
        u1: u0 + cw,
        v1: v0 + ch,
        biome,
        seed: (seed + i * 101 + j * 313) >>> 0,
      });
    }
  }

  /* ---- buildings -------------------------------------------------------- */
  const GOLDEN = 2.399963;
  const siteBuildings: BuildingSpec[][] = [];
  const siteBuilt: number[] = [];

  sites.forEach((site, si) => {
    const brng = mulberry32((seed * 7919 + si * 104729 + 17) >>> 0);
    const list: BuildingSpec[] = [];
    // Tie the number of plots to how much green there is, so a 4.5-tile
    // hamlet does not have to squeeze seven roofs onto its rim. `count` is the
    // baseline (scale-1) figure and drives the ring layout, so the rings stay
    // put no matter how many of them actually get built today.
    const count =
      si === 0
        ? clamp(Math.round((site.r - 3.2) * 1.4) + 3, 8, 10)
        : clamp(Math.round((site.r - 3.2) * 1.4) + Math.floor(brng() * 2), 3, 7);
    const lo = si === 0 ? 3 : 2;
    const hi = si === 0 ? 14 : 11;
    const countAt = (x: number) => clamp(Math.round(count * buildFactor(x)), lo, hi);
    const maxCount = countAt(SCALE_MAX);
    siteBuilt.push(Math.min(maxCount, countAt(S)));
    const usedLabels = new Set<string>();
    // Scale the architecture to the town so a small holding does not try to
    // fit a 64px hall inside a 5-tile green.
    const baseW = 20 + site.r * 1.9 + brng() * 4;

    const label = (role: StructureRole): string => {
      const opts = LABELS[role];
      for (let t = 0; t < 12; t++) {
        const l = pick(brng, opts);
        if (!usedLabels.has(l)) {
          usedLabels.add(l);
          return l;
        }
      }
      const l = `${opts[0]} — ${site.name}`;
      usedLabels.add(l);
      return l;
    };

    /** Footprints may never overlap; everything else can be relaxed. */
    const clearOfBuildings = (p: Pt, r: number, gap: number): boolean => {
      for (const b of list) {
        if (dist(p, [b.gx - b.gy, b.gx + b.gy]) < r + fpR(b.w) + gap) return false;
      }
      return true;
    };

    const STAGES = [
      { maxR: 1.02, gap: 0.8, road: 1.2, river: 1.6 },
      { maxR: 1.14, gap: 0.7, road: 1.0, river: 1.6 },
      { maxR: 1.3, gap: 0.5, road: 0.8, river: 1.3 },
      { maxR: 1.7, gap: 0.3, road: 0.4, river: 1.0 },
    ];

    const place = (i: number, r: number): Pt => {
      // Golden-angle rings around the green, spiralling outward and shedding
      // soft constraints stage by stage until the plot fits.
      const inner = count <= 4 ? count : Math.max(3, Math.round(count * 0.5));
      const base = i < inner ? 0.5 : 0.8;
      const jitter = 0.92 + brng() * 0.16;
      for (const st of STAGES) {
        for (let t = 0; t < 160; t++) {
          const rr = site.r * base * jitter + t * 0.06;
          if (rr + r > site.r * st.maxR) break;
          const a = i * GOLDEN + site.u * 0.11 + t * 0.401;
          const p: Pt = [site.u + Math.cos(a) * rr, site.v + Math.sin(a) * rr];
          if (!clearOfBuildings(p, r, st.gap)) continue;
          if (polyDist(p, river) < r + st.river) continue;
          if (st.road > 0 && roadLines.some((l) => polyDist(p, l) < r + st.road)) continue;
          return p;
        }
      }
      // Desperation: a fine spiral, anywhere that does not sit on another
      // roof. Now that streets run right through the green this gets used at
      // high scales, so the last sweep does not just take the first hit — it
      // takes the spot furthest from any road, which is what keeps a roof off
      // the carriageway when the town is genuinely full.
      let fallback: Pt | null = null;
      let fallbackClear = -Infinity;
      for (let sweep = 0; sweep < 2; sweep++) {
        const need = sweep === 0 ? r + 0.35 : r + 0.02;
        for (let t = 0; t < 900; t++) {
          const rr = site.r * 0.4 + t * 0.014;
          const a = i * GOLDEN + t * 0.2749;
          const p: Pt = [site.u + Math.cos(a) * rr, site.v + Math.sin(a) * rr];
          if (!clearOfBuildings(p, r, 0.15)) continue;
          let road = Infinity;
          for (const l of roadLines) road = Math.min(road, polyDist(p, l));
          if (road >= need) return p;
          if (road > fallbackClear) {
            fallbackClear = road;
            fallback = p;
          }
        }
      }
      return fallback ?? [site.u, site.v];
    };

    for (let i = 0; i < maxCount; i++) {
      const founding = si === 0 && i === 0;
      const landmark = founding ? false : (si === 0 ? i === 1 : i === 0);

      let role: StructureRole;
      let w: number;
      let floors: 1 | 2 | 3;
      if (founding) {
        role = 'homestead';
        w = 40 + Math.floor(brng() * 3) * 4; // 40 | 44 | 48
        floors = 2;
      } else if (landmark) {
        role = LANDMARK_ROLES[(si + landmarkOffset) % LANDMARK_ROLES.length];
        w = clamp(Math.round((baseW * 1.5) / 4) * 4, 44, 64);
        floors = brng() < 0.45 ? 3 : 2;
      } else {
        role = pick(brng, COMMON_ROLES);
        w = clamp(Math.round((baseW * (0.78 + brng() * 0.4)) / 4) * 4, 24, 52);
        floors = brng() < 0.34 ? 2 : 1;
      }

      const p = founding ? ([site.u, site.v] as Pt) : place(i, fpR(w));
      const roof: RoofStyle = founding
        ? 'gable'
        : THATCH_ROLES.has(role) && brng() < 0.72
          ? 'thatch'
          : brng() < 0.5
            ? 'hip'
            : 'gable';
      const [gx, gy] = uv(p[0], p[1]);
      list.push({
        id: `${site.id}-b${i}`,
        siteId: site.id,
        gx,
        gy,
        role,
        label: founding ? 'The First House' : label(role),
        w,
        floors,
        roof,
        chimney: founding || role === 'smithy' || role === 'cottage' || role === 'house' || brng() < 0.35,
        awning: role === 'store' || (role === 'workshop' && brng() < 0.5),
        banner: founding || landmark,
        cupola: role === 'chapel' || (role === 'tower' && brng() < 0.6),
        accent: site.accent,
        seed: (seed + si * 7717 + i * 613) >>> 0,
        clears: [],
      });
    }
    siteBuildings.push(list);
  });

  const allBuildings = siteBuildings.flat();

  /* ---- trees ------------------------------------------------------------ */
  // Real woodland. The day's story is crews cutting their way through it, so
  // the wood has to be thick enough that a road or a plot is genuinely carved
  // out of something. Density is concentrated where the work happens — inside
  // the town clearings and down the road corridors — while meadow stays open,
  // so the map keeps its contrast instead of turning into one green mat.
  const TREE_DENSITY: Record<Biome, number> = {
    forest: 0.27,
    meadow: 0.07,
    farm: 0.095,
    wetland: 0.12,
  };
  /** Extra trees packed into the town clearings, per unit area. */
  const GROVE_DENSITY = 0.36;
  /** Extra trees down the planned road corridors, and how wide they lie. */
  const CORRIDOR_DENSITY = 0.24;
  const CORRIDOR_HALF = 3;
  /** No two trunks closer than this. */
  const TREE_GAP = 0.62;
  /** Trees a single plot may require felled before it can be surveyed. */
  const PLOT_CLEAR_CAP = 11;
  const TREE_KINDS: Record<Biome, [TreeKind, number][]> = {
    forest: [['oak', 0.36], ['pine', 0.36], ['hedgerow', 0.16], ['blossom', 0.12]],
    meadow: [['oak', 0.46], ['blossom', 0.22], ['hedgerow', 0.24], ['pine', 0.08]],
    farm: [['hedgerow', 0.48], ['oak', 0.34], ['blossom', 0.18]],
    wetland: [['pine', 0.4], ['blossom', 0.22], ['oak', 0.2], ['hedgerow', 0.18]],
  };

  const trees: TreeSpec[] = [];
  const treeUV: Pt[] = [];
  let treeId = 0;

  // Trees may now stand ON a planned road — the crews fell them as they build
  // (see the road `clears` pass below). Only the water still pushes them back.
  const treeClear = (p: Pt): boolean => polyDist(p, river) >= 1.5;

  // Spacing test over a 1-unit hash grid, so thickening the wood stays linear.
  const cells = new Map<number, number[]>();
  const cellKey = (u: number, v: number) => (Math.floor(u) + 512) * 4096 + (Math.floor(v) + 512);
  const spaced = (p: Pt): boolean => {
    const cu = Math.floor(p[0]);
    const cv = Math.floor(p[1]);
    for (let du = -1; du <= 1; du++) {
      for (let dv = -1; dv <= 1; dv++) {
        const bucket = cells.get(cellKey(cu + du, cv + dv));
        if (!bucket) continue;
        for (const k of bucket) {
          if (dist(treeUV[k], p) < TREE_GAP) return false;
        }
      }
    }
    return true;
  };
  const rollKind = <T,>(r: number, table: [T, number][]): T => {
    let acc = 0;
    for (const [k, wt] of table) {
      acc += wt;
      if (r <= acc) return k;
    }
    return table[0][0];
  };
  const addTree = (p: Pt, kind: TreeKind, s: number) => {
    const [gx, gy] = uv(p[0], p[1]);
    const k = trees.length;
    trees.push({ id: `tr${treeId++}`, kind, gx, gy, seed: s >>> 0 });
    treeUV.push(p);
    const key = cellKey(p[0], p[1]);
    const bucket = cells.get(key);
    if (bucket) bucket.push(k);
    else cells.set(key, [k]);
  };

  for (const chunk of chunks) {
    const crng = mulberry32((chunk.seed + 991) >>> 0);
    const area = (chunk.u1 - chunk.u0) * (chunk.v1 - chunk.v0);
    const target = Math.round(area * TREE_DENSITY[chunk.biome]);
    const table = TREE_KINDS[chunk.biome];
    let placed = 0;
    for (let t = 0; t < target * 4 && placed < target; t++) {
      const p: Pt = [
        lerp(chunk.u0, chunk.u1, crng()),
        lerp(chunk.v0, chunk.v1, crng()),
      ];
      const kind = rollKind(crng(), table);
      if (!treeClear(p) || !spaced(p)) continue;
      addTree(p, kind, chunk.seed + t * 37);
      placed++;
    }
  }

  // Groves inside every town: the plots start forested, and the day's story is
  // clearing them. Without this pass the "farm" biome under a town would leave
  // nothing to fell.
  sites.forEach((site, si) => {
    const grng = mulberry32((seed + si * 3301 + 55) >>> 0);
    const target = Math.round(Math.PI * site.r * site.r * GROVE_DENSITY);
    let placed = 0;
    for (let t = 0; t < target * 6 && placed < target; t++) {
      const a = grng() * Math.PI * 2;
      const rad = Math.sqrt(grng()) * site.r * 1.02;
      const p: Pt = [site.u + Math.cos(a) * rad, site.v + Math.sin(a) * rad];
      if (!treeClear(p) || !spaced(p)) continue;
      addTree(p, rollKind(grng(), TREE_KINDS.forest), seed + si * 271 + t * 29);
      placed++;
    }
  });

  // Road corridors. Routes are planned through standing wood, so the crews
  // have something to cut on the way out — this is what puts a double-digit
  // clears list on a long forest route.
  roadLines.forEach((line, ri) => {
    const rrng = mulberry32((seed + ri * 40009 + 131) >>> 0);
    const cum = cumulative(line);
    const total = cum[cum.length - 1];
    const target = Math.round(total * CORRIDOR_HALF * 2 * CORRIDOR_DENSITY);
    let placed = 0;
    for (let t = 0; t < target * 6 && placed < target; t++) {
      const at = pointAtS(line, cum, rrng() * total);
      const a = rrng() * Math.PI * 2;
      const rad = Math.sqrt(rrng()) * CORRIDOR_HALF;
      const p: Pt = [at[0] + Math.cos(a) * rad, at[1] + Math.sin(a) * rad];
      if (p[0] < bounds.u0 || p[0] > bounds.u1 || p[1] < bounds.v0 || p[1] > bounds.v1) continue;
      if (!treeClear(p) || !spaced(p)) continue;
      addTree(p, rollKind(rrng(), TREE_KINDS.forest), seed + ri * 617 + t * 43);
      placed++;
    }
  });

  /* ---- clears: which trees stand on which plot -------------------------- */
  // Computed against the FULL building roster, not the scaled-down one. Felling
  // is what mutates the tree list, so it has to be blind to scale or the woods
  // would shift under the pace control. A plot that never gets built simply
  // keeps its `clears` list and nobody ever swings the axe.
  const dead = new Set<string>();
  const protectedTrees = new Set<string>();

  // The founding house pre-exists at t=0, so its plot is already open ground.
  {
    const f = siteBuildings[0][0];
    const fu = f.gx - f.gy;
    const fv = f.gx + f.gy;
    const clearR = fpR(f.w) + 2.5;
    trees.forEach((t, i) => {
      if (dist(treeUV[i], [fu, fv]) < clearR) dead.add(t.id);
    });
  }

  /* ---- clears: which trees stand on the routes -------------------------- */
  // Roads claim first: they are built before the plots they lead to, so a tree
  // in both a corridor and a plot belongs to the road. Claimed trees are never
  // deleted and never appear in a second list — the timeline fells each one
  // exactly once, as construction reaches its arclength.
  const ROAD_CLEAR = 0.9;
  const roadClaimed = new Set<string>();
  roads.forEach((road, ri) => {
    const line = roadLines[ri];
    const cum = cumulative(line);
    const total = cum[cum.length - 1] || 1;
    const list: { tree: string; frac: number }[] = [];
    trees.forEach((t, i) => {
      if (dead.has(t.id) || roadClaimed.has(t.id)) return;
      const p = treeUV[i];
      let bd = Infinity;
      let bs = 0;
      for (let k = 0; k + 1 < line.length; k++) {
        const d = segDist(p, line[k], line[k + 1]);
        if (d >= bd) continue;
        bd = d;
        const seg = dist(line[k], line[k + 1]) || 1;
        const proj = clamp(
          ((p[0] - line[k][0]) * (line[k + 1][0] - line[k][0]) +
            (p[1] - line[k][1]) * (line[k + 1][1] - line[k][1])) /
            (seg * seg),
          0,
          1
        );
        bs = cum[k] + seg * proj;
      }
      if (bd >= ROAD_CLEAR) return;
      roadClaimed.add(t.id);
      list.push({ tree: t.id, frac: clamp(bs / total, 0, 1) });
    });
    list.sort((a, b) => a.frac - b.frac || (a.tree < b.tree ? -1 : 1));
    road.clears = list;
  });

  /* ---- clears: which trees stand on which plot -------------------------- */
  for (const b of allBuildings) {
    if (b.role === 'homestead' && b.siteId === 's0' && b.id === 's0-b0') continue;
    const bu = b.gx - b.gy;
    const bv = b.gx + b.gy;
    const r = fpR(b.w) + 1.0;
    const cand: { id: string; d: number }[] = [];
    trees.forEach((t, i) => {
      // First claimant wins — roads before plots, and among plots whichever
      // was surveyed first. One tree, one axe.
      if (dead.has(t.id) || roadClaimed.has(t.id) || protectedTrees.has(t.id)) return;
      const d = dist(treeUV[i], [bu, bv]);
      if (d < r) cand.push({ id: t.id, d });
    });
    cand.sort((a, c) => a.d - c.d || (a.id < c.id ? -1 : 1));
    const keep = cand.slice(0, PLOT_CLEAR_CAP);
    for (const k of keep) {
      b.clears.push(k.id);
      protectedTrees.add(k.id);
    }
    for (const x of cand.slice(PLOT_CLEAR_CAP)) {
      // Over the cap. If a neighbouring plot already claimed it, leave it to
      // them — every tree is felled by exactly one claimant, so it never lands
      // in two clears lists. Otherwise it comes out of the map entirely rather
      // than being left standing under a finished roof.
      if (!protectedTrees.has(x.id)) dead.add(x.id);
    }
  }

  /* ---- wild scatter ----------------------------------------------------- */
  const scatter: PropSpec[] = [];
  const scatterUV: Pt[] = [];
  const SCATTER_KINDS: Record<Biome, [string, number][]> = {
    forest: [['bush', 0.4], ['rock', 0.2], ['stump', 0.16], ['flowers', 0.24]],
    meadow: [['flowers', 0.34], ['bush', 0.24], ['sheep', 0.24], ['rock', 0.18]],
    farm: [['bush', 0.34], ['flowers', 0.26], ['sheep', 0.24], ['rock', 0.16]],
    wetland: [['reeds', 0.56], ['bush', 0.2], ['rock', 0.14], ['flowers', 0.1]],
  };
  {
    const srng = mulberry32((seed ^ 0x5bf03635) >>> 0);
    for (let t = 0; t < scatterTarget * 12 && scatter.length < scatterTarget; t++) {
      const p: Pt = [
        lerp(bounds.u0 + 1, bounds.u1 - 1, srng()),
        lerp(bounds.v0 + 1, bounds.v1 - 1, srng()),
      ];
      if (!treeClear(p)) continue;
      let inSite = false;
      for (const s of sites) {
        if (dist(p, [s.u, s.v]) < s.r + 1) {
          inSite = true;
          break;
        }
      }
      if (inSite) continue;
      const nearRiver = polyDist(p, river);
      let biome: Biome = 'meadow';
      for (const c of chunks) {
        if (p[0] >= c.u0 && p[0] < c.u1 && p[1] >= c.v0 && p[1] < c.v1) {
          biome = c.biome;
          break;
        }
      }
      let kind = rollKind(srng(), SCATTER_KINDS[biome] as [TreeKind, number][]) as string;
      if (kind === 'reeds' && nearRiver > 4.5) kind = 'bush';
      if (nearRiver < 3.2 && srng() < 0.45) kind = 'reeds';
      const [gx, gy] = uv(p[0], p[1]);
      scatter.push({ id: `pr${scatter.length}`, kind, gx, gy, seed: (seed + t * 131) >>> 0 });
      scatterUV.push(p);
    }
  }

  /* ---- site dressing ---------------------------------------------------- */
  const siteProps: PropSpec[][] = sites.map((site, si) => {
    const prng = mulberry32((seed + si * 60013 + 7) >>> 0);
    const props: PropSpec[] = [];
    const placedUV: Pt[] = [];

    const ok = (p: Pt): boolean => {
      if (dist(p, [site.u, site.v]) > site.r * 0.92) return false;
      if (polyDist(p, river) < 1.6) return false;
      for (const line of roadLines) {
        if (polyDist(p, line) < 1.3) return false;
      }
      for (const b of siteBuildings[si]) {
        const bu = b.gx - b.gy;
        const bv = b.gx + b.gy;
        if (dist(p, [bu, bv]) < fpR(b.w) + 1.0) return false;
      }
      for (const q of placedUV) {
        if (dist(p, q) < 1.6) return false;
      }
      return true;
    };
    const add = (id: string, kind: string, p: Pt, s: number) => {
      const [gx, gy] = uv(p[0], p[1]);
      props.push({ id, kind, gx, gy, seed: s >>> 0 });
      placedUV.push(p);
    };
    /** Ring search around the green at a preferred radius. */
    const spot = (prefR: number, prefA: number): Pt => {
      for (let t = 0; t < 96; t++) {
        const a = prefA + t * 0.61;
        const rr = site.r * clamp(prefR + (t % 10) * 0.03, 0.16, 0.9);
        const p: Pt = [site.u + Math.cos(a) * rr, site.v + Math.sin(a) * rr];
        if (ok(p)) return p;
      }
      // Relaxed sweep: dressing may crowd a road or its neighbours, but it must
      // never end up standing inside somebody's front room.
      for (let t = 0; t < 200; t++) {
        const a = prefA + t * 0.401;
        const rr = site.r * clamp(0.2 + t * 0.006, 0.16, 0.95);
        const p: Pt = [site.u + Math.cos(a) * rr, site.v + Math.sin(a) * rr];
        let clash = false;
        for (const b of siteBuildings[si]) {
          if (dist(p, [b.gx - b.gy, b.gx + b.gy]) < fpR(b.w) + 0.6) {
            clash = true;
            break;
          }
        }
        if (!clash && placedUV.every((q) => dist(p, q) > 1.0)) return p;
      }
      const a = prefA;
      return [site.u + Math.cos(a) * site.r * 0.3, site.v + Math.sin(a) * site.r * 0.3];
    };

    // Order matters: it is the order the dressing appears over the day.
    add(`${site.id}-well`, 'well', spot(0.3, prng() * Math.PI * 2), 5 + si);

    // Nameboard out along the first road that leaves town.
    let signA = prng() * Math.PI * 2;
    for (const r of roads) {
      if (r.from !== site.id && r.to !== site.id) continue;
      const end = r.from === site.id ? r.pts[0] : r.pts[r.pts.length - 1];
      signA = Math.atan2(end[0] + end[1] - site.v, end[0] - end[1] - site.u);
      break;
    }
    add(`${site.id}-sign`, 'nameboard', spot(0.8, signA), 21 + si);

    const lamps = site.r > 6.5 ? 2 : 1;
    for (let i = 0; i < lamps; i++) {
      add(`${site.id}-lamp${i}`, 'lamp', spot(0.44, signA + Math.PI * (0.6 + i)), 31 + i + si * 3);
    }

    const flavour = 2 + Math.floor(prng() * 4); // 2..5
    for (let i = 0; i < flavour; i++) {
      const kind = FLAVOUR_PROPS[Math.floor(prng() * FLAVOUR_PROPS.length)];
      add(`${site.id}-p${i}`, kind, spot(0.62 + prng() * 0.22, prng() * Math.PI * 2), 200 + si * 31 + i);
    }
    return props;
  });

  // Dressing wins over undergrowth: fell any unclaimed tree standing on a prop.
  siteProps.forEach((props) => {
    for (const p of props) {
      const pu = p.gx - p.gy;
      const pv = p.gx + p.gy;
      trees.forEach((t, i) => {
        if (protectedTrees.has(t.id) || roadClaimed.has(t.id) || dead.has(t.id)) return;
        if (dist(treeUV[i], [pu, pv]) < 1.1) dead.add(t.id);
      });
    }
  });

  const liveTrees = trees.filter((t) => !dead.has(t.id));

  /* ---- assemble --------------------------------------------------------- */
  // The only place `scale` is allowed to bite: trim the roster to the towns
  // and plots the day will actually reach. Everything above was computed
  // against the full roster, so the trim is a pure prefix.
  const siteSpecs: SiteSpec[] = sites.slice(0, nSites).map((s, i) => {
    const [gx, gy] = uv(s.u, s.v);
    return {
      id: s.id,
      name: s.name,
      gx,
      gy,
      radius: s.r,
      accent: s.accent,
      buildings: siteBuildings[i].slice(0, siteBuilt[i]),
      props: siteProps[i],
    };
  });

  return {
    version: 1,
    seed: seed >>> 0,
    bounds,
    content,
    chunks,
    river: river.map((p) => uv(p[0], p[1]) as Vec2),
    riverWidth,
    sites: siteSpecs,
    roads: activeRoads,
    bridges: activeBridges,
    trees: liveTrees,
    scatter,
    valleyName: valley,
  };
}
