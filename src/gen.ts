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
 *   bounds -> river -> lakes -> outcrops -> town roster -> accents/names ->
 *   road network (append-only tree, A* routed) -> crossings (a bridge for a
 *   highway or a lane, a ford for a track) -> chunks/biomes ->
 *   buildings -> trees -> clears -> wild scatter -> shores and boulder fields
 *   -> site dressing -> trim to scale.
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
  type ChestReward,
  type ChestSpec,
  type Chunk,
  type FordSpec,
  type GenesisMap,
  type LakeSpec,
  type PropSpec,
  type RoadSpec,
  type RoofStyle,
  /* ---- ruins (additive) ---- */
  type RuinKind,
  type RuinSpec,
  /* ---- end ruins (additive) ---- */
  /* ---- founders and professions (additive) ---- */
  type Profession,
  /* ---- end founders and professions (additive) ---- */
  /* ---- standing stones (additive) ---- */
  type StoneKind,
  type StoneSpec,
  /* ---- end standing stones (additive) ---- */
  type SiteSpec,
  type StructureRole,
  type TreeKind,
  type TreeSpec,
  type Vec2,
} from './types.ts';
import {
  /* ---- founders and professions (additive) ---- */
  founderNames,
  /* ---- end founders and professions (additive) ---- */
  valleyName,
  /* ---- standing stones (additive) ---- */
  stoneTownName,
  townNamesDrawn,
  /* ---- end standing stones (additive) ---- */
} from './names.ts';

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

/** The point on segment a-b nearest `p`. `segDist` without the final hypot. */
function segClosest(p: Pt, a: Pt, b: Pt): Pt {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy || 1;
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [a[0] + vx * t, a[1] + vy * t];
}

function polyDist(p: Pt, line: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const d = segDist(p, line[i], line[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * The segments of `line` that could possibly come within `pad` of any point in
 * the box [u0,v0]-[u1,v1]. A segment whose own AABB, grown by `pad`, misses the
 * box is strictly further than `pad` from every point in the box, so dropping
 * it can never change a `polyDist(p, line) < pad` test for p inside the box.
 */
function segsNearBox(
  line: Pt[],
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  pad: number
): Pt[][] {
  const out: Pt[][] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    if (Math.max(a[0], b[0]) + pad < u0 || Math.min(a[0], b[0]) - pad > u1) continue;
    if (Math.max(a[1], b[1]) + pad < v0 || Math.min(a[1], b[1]) - pad > v1) continue;
    out.push([a, b]);
  }
  return out;
}

/** True when any segment in `segs` comes closer than `d` to `p`. */
function anySegWithin(p: Pt, segs: Pt[][], d: number): boolean {
  for (let i = 0; i < segs.length; i++) {
    if (segDist(p, segs[i][0], segs[i][1]) < d) return true;
  }
  return false;
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
/*  lakes and outcrops — geometry                                             */
/* ========================================================================== */

/**
 * The working form of a lake inside the generator: the analytic shape, in u/v.
 * `LakeSpec` in types.ts is this plus the resolved outline in tile space.
 */
interface Lake {
  id: string;
  u: number;
  v: number;
  rx: number;
  ry: number;
  rot: number;
  /** low-order radial wobble, drawn from the lake's own substream */
  w1: number;
  w2: number;
  p1: number;
  p2: number;
  seed: number;
  fed: boolean;
  /* --- derived once at construction; every field below is a pure function of
     the ones above, cached because `lakeDist` sits under the tree loop. --- */
  /** the outline never reaches past this radius from the centre */
  maxR: number;
  /** cos/sin of -rot, for the world -> lake-frame rotation */
  cr: number;
  sr: number;
  /** mean semi-axis — the honest scale of the lake, for laying out its shore */
  mean: number;
  /**
   * SMALLEST semi-axis, and what `lakeDist` scales its normalised residual by.
   * Using the mean would make the reported distance too generous across the
   * lake's narrow waist, which is the one direction where being generous puts
   * a roof in the water. The smallest axis makes every answer a conservative
   * under-estimate of the true distance, so a margin is always at least met.
   */
  unit: number;
}

/** Fill in a lake's derived fields. The one place `Lake` is constructed. */
function makeLake(l: Omit<Lake, 'maxR' | 'cr' | 'sr' | 'mean' | 'unit'>): Lake {
  return {
    ...l,
    maxR: Math.max(l.rx, l.ry) * (1 + Math.abs(l.w1) + Math.abs(l.w2)),
    cr: Math.cos(-l.rot),
    sr: Math.sin(-l.rot),
    mean: (l.rx + l.ry) / 2,
    unit: Math.min(l.rx, l.ry),
  };
}

/** Shape radius (a multiple of the ellipse) at angle `a` in the lake's frame. */
const lakeShape = (l: Lake, a: number) =>
  1 + l.w1 * Math.sin(3 * a + l.p1) + l.w2 * Math.sin(5 * a + l.p2);

/**
 * Signed distance from `p` to the lake's shore, in u/v units: negative inside
 * the water, positive on the land. Approximate — the normalised radial residual
 * scaled back by the mean semi-axis — but monotonic and exact at the shore
 * itself, which is all any of the clearance tests below need.
 */
function lakeDist(p: Pt, l: Lake): number {
  const du = p[0] - l.u;
  const dv = p[1] - l.v;
  const x = (du * l.cr - dv * l.sr) / l.rx;
  const y = (du * l.sr + dv * l.cr) / l.ry;
  const r = Math.hypot(x, y);
  if (r < 1e-9) return -l.unit;
  return (r - lakeShape(l, Math.atan2(y, x))) * l.unit;
}

/** Nearest shore distance over every lake; +Infinity when there are none. */
function lakesDist(p: Pt, lakes: Lake[]): number {
  let best = Infinity;
  for (const l of lakes) {
    const d = lakeDist(p, l);
    if (d < best) best = d;
  }
  return best;
}

/**
 * "Is `p` within `margin` of any shore?" — the form every rejection test wants,
 * and the one that gets called tens of thousands of times per world. The
 * squared bounding-circle test in front is exact (nothing outside the circle
 * can be inside the margin) and skips the trig for all but a handful of points.
 */
function lakesWithin(p: Pt, lakes: Lake[], margin: number): boolean {
  for (const l of lakes) {
    const du = p[0] - l.u;
    const dv = p[1] - l.v;
    const bound = margin + l.maxR;
    if (du * du + dv * dv > bound * bound) continue;
    if (lakeDist(p, l) < margin) return true;
  }
  return false;
}

/** The lake outline in u/v, at `k` times its nominal radius. */
function lakeOutline(l: Lake, k: number, n = 28): Pt[] {
  const c = Math.cos(l.rot);
  const s = Math.sin(l.rot);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = lakeShape(l, a) * k;
    const x = Math.cos(a) * l.rx * rr;
    const y = Math.sin(a) * l.ry * rr;
    out.push([l.u + x * c - y * s, l.v + x * s + y * c]);
  }
  return out;
}

/**
 * One lake standing on its own, centred on the origin — the same wobble draw
 * and the same outline `makeLakes` produces, without a valley around it.
 *
 * Additive: `generateMap` does not call this and no world changes shape because
 * of it. It exists so the dev catalog page can bake a real `LakeSpec` without
 * generating a whole map to fish one out of.
 */
export function sampleLake(seed: number, rx = 3.4, ry = 2.6): LakeSpec {
  const srng = mulberry32((seed ^ 0x3d9f1b27) >>> 0);
  const l = makeLake({
    id: 'lk-sample',
    u: 0,
    v: 0,
    rx,
    ry,
    w1: 0.06 + srng() * 0.11,
    w2: 0.03 + srng() * 0.07,
    p1: srng() * Math.PI * 2,
    p2: srng() * Math.PI * 2,
    rot: srng() * Math.PI * 2,
    seed: seed >>> 0,
    fed: false,
  });
  const [gx, gy] = uv(l.u, l.v);
  return {
    id: l.id,
    gx,
    gy,
    rx: l.rx,
    ry: l.ry,
    rot: l.rot,
    seed: l.seed,
    fed: l.fed,
    pts: lakeOutline(l, 1).map((p) => uv(p[0], p[1]) as Vec2),
  };
}

/**
 * Nudge a polyline out of every lake it strays into.
 *
 * A* already routes around the water, but the smoothing that follows (simplify
 * → chaikin → the bridge straightener) cuts corners, and the one corner a road
 * skirting a lake has is the lake. Pushing the offenders back out along their
 * own radial is a small, local, rng-free correction; the midpoint pass catches
 * a straight chord sliced across a narrow neck between two outside vertices.
 */
function pushOutOfLakes(line: Pt[], lakes: Lake[], margin: number): Pt[] {
  if (!lakes.length) return line;
  const push = (p: Pt): Pt => {
    for (const l of lakes) {
      const d = lakeDist(p, l);
      if (d >= margin) continue;
      const du = p[0] - l.u;
      const dv = p[1] - l.v;
      const len = Math.hypot(du, dv) || 1;
      const step = margin - d + 0.05;
      p = [p[0] + (du / len) * step, p[1] + (dv / len) * step];
    }
    return p;
  };
  let cur = line.map(push);
  for (let pass = 0; pass < 2; pass++) {
    const out: Pt[] = [cur[0]];
    let split = false;
    for (let i = 1; i < cur.length; i++) {
      const mid: Pt = [(cur[i - 1][0] + cur[i][0]) / 2, (cur[i - 1][1] + cur[i][1]) / 2];
      if (lakesDist(mid, lakes) < margin) {
        out.push(push(mid));
        split = true;
      }
      out.push(cur[i]);
    }
    cur = out;
    if (!split) break;
  }
  return cur;
}

/* ========================================================================== */
/*  lakes and outcrops — placement                                            */
/* ========================================================================== */

/** The working form of an outcrop: u/v, plus the radius its boulders fill. */
interface Outcrop {
  id: string;
  u: number;
  v: number;
  radius: number;
  seed: number;
}

/**
 * How many lakes the day gets. Roughly a third of valleys have none at all,
 * which is the point — a lake in every valley is a checklist, not weather.
 */
const lakeCount = (r: number): number => (r < 0.32 ? 0 : r < 0.76 ? 1 : 2);

/**
 * Standing water, laid down straight after the river and before anything that
 * could get in its way. Nothing here reads the pace scale, so lakes are
 * byte-identical at every scale by construction.
 *
 * The ellipse and its position come off the MAIN stream (this is the one
 * sanctioned reseed this feature performs — see buildMap); the shape wobble
 * comes off a per-lake substream keyed on (seed, index), so the outline detail
 * costs the main stream nothing and cannot drift if the wobble is ever retuned.
 */
function makeLakes(
  rng: () => number,
  seed: number,
  content: { u0: number; v0: number; u1: number; v1: number },
  river: Pt[]
): Lake[] {
  const n = lakeCount(rng());
  const lakes: Lake[] = [];
  for (let i = 0; i < n; i++) {
    // Shape first, off the lake's own stream: the wobble decides the bounding
    // radius, and the bounding radius is what every constraint below tests.
    const srng = mulberry32((seed ^ 0x3d9f1b27 ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0);
    const w1 = 0.06 + srng() * 0.11;
    const w2 = 0.03 + srng() * 0.07;
    const p1 = srng() * Math.PI * 2;
    const p2 = srng() * Math.PI * 2;
    const wob = 1 + w1 + w2;

    // One lake a day may be fed by the river; the rest stand on their own.
    const wantFed = i === 0 && rng() < 0.42;
    let placed = false;
    for (let pass = 0; pass < 2 && !placed; pass++) {
      const fed = wantFed && pass === 0;
      for (let t = 0; t < 500 && !placed; t++) {
        const rx = 2.2 + rng() * 2.1; // 4.4 .. 8.6 units across the long way
        const ry = rx * (0.64 + rng() * 0.36); // and never thinner than 2/3 of it
        const rot = rng() * Math.PI * 2;
        const maxR = Math.max(rx, ry) * wob;
        const margin = maxR + 3;
        const u = lerp(content.u0 + margin, content.u1 - margin, rng());
        const v = lerp(content.v0 + margin, content.v1 - margin, rng());
        const c: Pt = [u, v];
        // Leave the middle of the valley to the founding house.
        if (Math.hypot(u, v) < 12) continue;
        const dRiver = polyDist(c, river);
        if (fed) {
          // The water has to run into the rim, not across the middle.
          const inner = Math.min(rx, ry) * wob;
          if (dRiver < inner * 0.6 || dRiver > inner * 0.98) continue;
        } else if (dRiver < maxR + 2.4) continue;
        let clash = false;
        for (const o of lakes) {
          if (dist(c, [o.u, o.v]) < maxR + o.maxR + 3) {
            clash = true;
            break;
          }
        }
        if (clash) continue;
        lakes.push(
          makeLake({
            id: `lk${lakes.length}`,
            u,
            v,
            rx,
            ry,
            rot,
            w1,
            w2,
            p1,
            p2,
            seed: (seed + i * 26417 + 13) >>> 0,
            fed,
          })
        );
        placed = true;
      }
    }
  }
  return lakes;
}

/**
 * Bare rock: 1-2 clusters, off the water and off the lakes, and never dead
 * centre. A town that ends up within QUARRY_REACH of one builds in stone.
 */
function makeOutcrops(
  rng: () => number,
  seed: number,
  content: { u0: number; v0: number; u1: number; v1: number },
  river: Pt[],
  lakes: Lake[]
): Outcrop[] {
  const n = rng() < 0.45 ? 1 : 2;
  const out: Outcrop[] = [];
  for (let i = 0; i < n; i++) {
    let placed = false;
    for (let t = 0; t < 500 && !placed; t++) {
      const radius = 2.4 + rng() * 2.0;
      const margin = radius + 5;
      const u = lerp(content.u0 + margin, content.u1 - margin, rng());
      const v = lerp(content.v0 + margin, content.v1 - margin, rng());
      const c: Pt = [u, v];
      if (Math.hypot(u, v) < 13) continue;
      if (polyDist(c, river) < radius + 3.5) continue;
      if (lakesDist(c, lakes) < radius + 3) continue;
      let clash = false;
      for (const o of out) {
        if (dist(c, [o.u, o.v]) < radius + o.radius + 12) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      out.push({ id: `oc${out.length}`, u, v, radius, seed: (seed + i * 31337 + 71) >>> 0 });
      placed = true;
    }
  }
  return out;
}

/**
 * How close a town's rim has to come to an outcrop before it quarries it.
 * Measured centre-to-centre less both radii, so it means what it says however
 * big the town and the rock happen to be.
 */
export const QUARRY_REACH = 6;

/**
 * How near a river crossing has to come to bare rock before the crossing is
 * built out of it, whatever the towns at either end build in. Measured from the
 * crossing to the outcrop's rim, so it means what it says however big the rock.
 *
 * Generous next to QUARRY_REACH on purpose: a town has to LIVE beside its
 * quarry, a bridge only has to be within carting distance of one.
 */
export const STONE_BRIDGE_REACH = 8;

const quarriesFrom = (u: number, v: number, r: number, outcrops: Outcrop[]): Outcrop | null => {
  let best: Outcrop | null = null;
  let bd = Infinity;
  for (const o of outcrops) {
    const d = dist([u, v], [o.u, o.v]) - o.radius - r;
    if (d <= QUARRY_REACH && d < bd) {
      bd = d;
      best = o;
    }
  }
  return best;
};

/* ========================================================================== */
/*  palettes and tables                                                       */
/* ========================================================================== */

/**
 * Pastel gems, same family as GEM_COLORS in src/data/islands.ts.
 *
 * There must be at least as many of these as the biggest roster the pace
 * control can ask for (`rosterMax`, capped at 16), because a site takes
 * `pool[i % pool.length]` — with a shorter list the sixteenth town would wear
 * the first town's colour and the two would read as one project. The four
 * after the original fourteen fill the gaps that list left in the hue wheel:
 * yellow-green, spring green, periwinkle and orchid.
 */
export const ACCENTS = [
  '#ef7f93', '#f5a25d', '#f0c75e', '#6cc4d9', '#9b8fe8', '#63c9a8', '#e98fc3',
  '#7fb2ef', '#d9a066', '#8fd68f', '#c78ff0', '#5fbfa8', '#efb0a0', '#a8c96e',
  '#c3d768', '#6fd18c', '#8fa5ee', '#dd8ae0',
];

/** One landmark per site, rotated so no two towns share a silhouette. */
export const LANDMARK_ROLES: StructureRole[] = [
  'hall', 'mill', 'chapel', 'granary', 'tower', 'smithy', 'barn', 'brewhouse',
];

/**
 * Weighted pool for ordinary plots. Chapels and towers are deliberately absent
 * — they are landmark silhouettes, and three chapels in one hamlet reads as a
 * bug rather than as variety.
 */
export const COMMON_ROLES: StructureRole[] = [
  'cottage', 'cottage', 'cottage', 'cottage', 'house', 'house', 'house',
  'store', 'store', 'workshop', 'workshop', 'shed', 'shed', 'barn',
  'granary', 'smithy', 'mill', 'bakery', 'bakery',
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
  bakery: ['The Bakehouse', 'The Oven House', 'Loaf & Ladle', 'The Baker’s'],
  brewhouse: ['The Brewhouse', 'The Oast House', 'The Malting', 'Hop Yard'],
  // Charter-only. There is never more than one in a valley, so the list is
  // short and every entry has to be able to carry the whole building.
  gildhall: ['The Gildhall', 'The Charter House', 'The Freemen’s Hall', 'The Warrant House'],
};

export const THATCH_ROLES = new Set<StructureRole>(['cottage', 'barn', 'shed', 'homestead']);

/** Flavour dressing that shows up as a town matures. */
export const FLAVOUR_PROPS = ['crop', 'haystack', 'crates', 'barrels', 'cart', 'shed'];

/* ============ founders and professions (additive block) ================== *
 * A town's trade, and the two bags it re-weights.
 *
 * ── THE ONE RULE ──────────────────────────────────────────────────────────
 * A profession may change WHAT a roll means. It may never change HOW MANY
 * rolls are made. Both bags below are read with exactly the single draw the
 * plain bag was read with — `pick(brng, bag)` and `bag[floor(prng()*len)]` —
 * so a differently sized bag is fine and a differently shaped one is not. Get
 * that wrong and every stream downstream of it shifts, which is the one way
 * this feature could have broken subset stability.
 * -------------------------------------------------------------------------- */

/** How close a town's RIM must come to the river bank or a lake shore, in u/v,
 * before it is a fishing town. Deliberately generous next to JETTY_REACH: a
 * town can live off water it cannot moor a boat on. */
export const FISH_REACH = 5;

/** The disc, in u/v, that a town's founding wood is counted over … */
export const LOG_REACH = 8;
/**
 * … and how many WILD trees have to be standing in it.
 *
 * Wild means the chunk planting pass only — not the grove the town clears out
 * of its own green, and not the trees a road corridor brought with it, neither
 * of which says anything about the country the town chose.
 *
 * 22 over a disc of ~201 u² looks low against the forest biome's 0.27/u², and
 * it is: no town in the valley is founded in deep wood, because the chunk pass
 * lays a ring of `farm` around every baseline holding before a single tree goes
 * in. The figure is calibrated instead so that roughly the woodiest fifth of
 * the roster qualifies — which is what "this lot went out to where the timber
 * was" has to mean in a valley that ploughs its own doorstep.
 */
export const LOG_TREES = 22;

/** How far past its rim a town counts ploughed ground, and how many farm
 * chunks it takes. Two, because one is the halo every town grows for itself. */
export const FARM_REACH = 9;
export const FARM_CHUNKS = 4;

/**
 * The ordinary-plot bag, per trade. Each is COMMON_ROLES with a handful of
 * entries added, so the shift is a nudge in the odds rather than a different
 * town: a fishing town still builds mostly cottages, it just keeps more of
 * its goods under cover.
 */
export const PROFESSION_ROLES: Record<Profession, StructureRole[]> = {
  // Nets, salt, barrels, and somewhere dry to put all three.
  fishing: [...COMMON_ROLES, 'store', 'store', 'store', 'shed', 'shed'],
  // Sawyers and joiners, and lean-tos full of what they cut.
  logging: [...COMMON_ROLES, 'workshop', 'workshop', 'workshop', 'shed', 'shed'],
  // Somewhere to put the harvest before the rain gets at it.
  farming: [...COMMON_ROLES, 'barn', 'barn', 'granary', 'granary', 'shed'],
  plain: COMMON_ROLES,
};

/** The flavour-dressing bag, per trade. Same rule: one draw, any length. */
export const PROFESSION_FLAVOUR: Record<Profession, string[]> = {
  fishing: [...FLAVOUR_PROPS, 'crates', 'barrels', 'crates', 'barrels'],
  logging: [...FLAVOUR_PROPS, 'lumber', 'lumber', 'lumber', 'cart'],
  farming: [...FLAVOUR_PROPS, 'haystack', 'crop', 'haystack', 'crop'],
  plain: FLAVOUR_PROPS,
};

/* ========== end founders and professions (additive block) ================ */

/* --------------------------- boats and jetties --------------------------- *
 * ADDITIVE BLOCK. A town builds a jetty when it has water to build one on and
 * not otherwise, which is the whole point: it has to be earned by geography.
 * -------------------------------------------------------------------------- */

/**
 * How far a town's RIM may be from the RIVER bank and still get a jetty, in
 * u/v. Measured rim-to-bank, so it means the same thing for a big town and a
 * small one — the same convention as QUARRY_REACH.
 *
 * Tight, because the river is everywhere: half the valley's towns are within a
 * few units of it, and at any generous figure a jetty stops being a feature of
 * the map and becomes standard town furniture.
 */
export const JETTY_REACH = 1.2;

/**
 * The same, for a LAKE. Much longer, and deliberately so: towns are pushed well
 * back off standing water when they are surveyed (nothing is ever built on a
 * shore), so at the river's figure no lake in the valley would ever get a pier.
 * A town will walk a little way for water it can actually moor a boat on.
 */
export const JETTY_LAKE_REACH = 5;

/** Deck length out over the water, u/v. The art draws exactly this. */
export const JETTY_LEN = 2.2;

/** How far up the bank the landward end of the deck sits, u/v. */
const JETTY_ROOT = 0.62;

/** Base woodland mix per biome, before the day's forest character is applied. */
const BASE_TREE_KINDS: Record<Biome, [TreeKind, number][]> = {
  forest: [['oak', 0.26], ['pine', 0.22], ['fir', 0.16], ['birch', 0.16], ['hedgerow', 0.1], ['blossom', 0.1]],
  meadow: [['oak', 0.34], ['hedgerow', 0.2], ['birch', 0.18], ['blossom', 0.18], ['pine', 0.1]],
  farm: [['hedgerow', 0.4], ['oak', 0.28], ['blossom', 0.18], ['birch', 0.14]],
  wetland: [['willow', 0.3], ['pine', 0.22], ['birch', 0.14], ['blossom', 0.14], ['oak', 0.1], ['hedgerow', 0.1]],
  moor: [['hedgerow', 0.46], ['fir', 0.3], ['pine', 0.16], ['birch', 0.08]],
};

/**
 * The day's forest character: the one kind that runs away with the wood. Two
 * valleys a day apart should not be the same green, and a character does more
 * for that than any amount of per-tree jitter — a fir-dark valley and a
 * birch-bright one read as different country from the fitted overview.
 *
 * Drawn from a substream of the seed alone (never the main stream, never the
 * scale), so it cannot move when the pace control trims the roster.
 */
const WOOD_CHARACTERS: { name: string; kind: TreeKind; boost: number }[] = [
  { name: 'oakwood', kind: 'oak', boost: 0.42 },
  { name: 'birchvale', kind: 'birch', boost: 0.5 },
  { name: 'firdark', kind: 'fir', boost: 0.52 },
  { name: 'pinewood', kind: 'pine', boost: 0.44 },
  { name: 'blossomvale', kind: 'blossom', boost: 0.34 },
  { name: 'hedgeland', kind: 'hedgerow', boost: 0.34 },
  { name: 'mixed', kind: 'oak', boost: 0 },
];

const woodChar = (seed: number) =>
  WOOD_CHARACTERS[Math.floor(mulberry32((seed ^ 0x2f6a88c3) >>> 0)() * WOOD_CHARACTERS.length)];

/** Every forest character a day can be drawn from, by name. */
export const WOOD_CHARACTER_NAMES: string[] = WOOD_CHARACTERS.map((c) => c.name);

/** The day's forest character, by name. Exported for the test harness. */
export const woodCharacter = (seed: number): string => woodChar(seed).name;

/** Per-biome tree-kind tables for one seed, re-weighted by its character. */
function woodland(seed: number): Record<Biome, [TreeKind, number][]> {
  const ch = woodChar(seed);
  const out = {} as Record<Biome, [TreeKind, number][]>;
  for (const key of Object.keys(BASE_TREE_KINDS) as Biome[]) {
    const base = BASE_TREE_KINDS[key];
    // The wet ground keeps its willows whatever the character — they are what
    // makes a river bank read as a river bank.
    const boost = key === 'wetland' ? ch.boost * 0.4 : ch.boost;
    const rows: [TreeKind, number][] = base.map(([k, w]) => [k, k === ch.kind ? w + boost : w]);
    if (boost > 0 && !base.some(([k]) => k === ch.kind)) rows.push([ch.kind, boost]);
    let total = 0;
    for (const [, w] of rows) total += w;
    out[key] = rows.map(([k, w]) => [k, w / total] as [TreeKind, number]);
  }
  return out;
}

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
  /** Signed shore distance to the nearest lake; +LAKE_FAR where there is none. */
  lakeD: Float32Array;
}

/** Beyond this the lake cost is flat zero, so it need not be stored exactly. */
const LAKE_FAR = 99;

function buildRouteGrid(
  content: { u0: number; v0: number; u1: number; v1: number },
  river: Pt[],
  lakes: Lake[]
): RouteGrid {
  const u0 = Math.ceil(content.u0);
  const v0 = Math.ceil(content.v0);
  const w = Math.floor(content.u1) - u0 + 1;
  const h = Math.floor(content.v1) - v0 + 1;
  const riverD = new Float32Array(w * h);
  const riverTu = new Float32Array(w * h);
  const riverTv = new Float32Array(w * h);
  const lakeD = new Float32Array(w * h).fill(LAKE_FAR);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const near = polyNear([u0 + i, v0 + j], river);
      const k = j * w + i;
      riverD[k] = near.d;
      riverTu[k] = near.tu;
      riverTv[k] = near.tv;
    }
  }
  // Only the cells the lake can actually reach are visited, so a valley with no
  // lakes pays nothing at all for this and a valley with two pays for two
  // little boxes rather than for the whole grid.
  for (const l of lakes) {
    const reach = l.maxR + LAKE_ZONE + 1;
    const i0 = clamp(Math.floor(l.u - reach - u0), 0, w - 1);
    const i1 = clamp(Math.ceil(l.u + reach - u0), 0, w - 1);
    const j0 = clamp(Math.floor(l.v - reach - v0), 0, h - 1);
    const j1 = clamp(Math.ceil(l.v + reach - v0), 0, h - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * w + i;
        const d = lakeDist([u0 + i, v0 + j], l);
        if (d < lakeD[k]) lakeD[k] = d;
      }
    }
  }
  return { u0, v0, w, h, riverD, riverTu, riverTv, lakeD };
}

/** Cost of stepping into a river cell: cheap across, ruinous along. */
const RIVER_ZONE = 2.3;
const riverStepCost = (align: number) => 6 + 110 * align * align;

/**
 * The water itself is all but impassable — a road crossing a lake reads as a
 * bug, where a road crossing a river reads as a bridge waiting to be built. The
 * shoulder outside it is only mildly discouraged, and deliberately wide: it is
 * what stops the smoothing passes from cutting the corner back into the water,
 * and a lane that runs along a shore two units out is the whole point.
 */
const LAKE_ZONE = 2.4;
const lakeStepCost = (d: number) => (d < 0 ? 900 : 22 * (1 - d / LAKE_ZONE));

/**
 * How far a finished road centreline must stay off a shore, in u/v. A road is
 * ~1.2 u/v wide at the verge, so this puts the carriageway on the sand rim and
 * the water just past it — which is the shot: a lane running along the water.
 */
const ROAD_LAKE_CLEAR = 1.7;

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
      if (grid.lakeD[nb] < LAKE_ZONE) c += lakeStepCost(grid.lakeD[nb]) * step;
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
/*  buried treasure                                                           */
/* ========================================================================== */

/**
 * Scheduled serendipity.
 *
 * A seed buries nought, one or two chests in the deep wood or out on the open
 * moor, always well off the road network, and decides then and there what is in
 * each one and which town's crews will turn it up. Whether the day's digging
 * finds it at all is decided here too, and for a hard reason: the reward for a
 * coin hoard is EXTRA BUILDINGS, and buildings are map data. A timeline cannot
 * conjure a plot the map never surveyed. So the map owns the day's luck; the
 * timeline owns the day's clock and all of its words.
 *
 * ── THE SCALE RULE ────────────────────────────────────────────────────────
 * Chests are TERRAIN: every field of every ChestSpec is a pure function of the
 * seed and is byte-identical at 0.25x and at 4x. Nothing below reads `scale`.
 *
 * The reward is NOT terrain — it is expressed entirely through the finding
 * town's building roster and the existing `siteBuilt` prefix mechanism:
 *
 *   coin     `grant` ordinary plots are APPENDED to that town's full roster and
 *            `siteBuilt` is raised by exactly `grant` at every scale. A prefix
 *            of length countAt(S) + grant is still a prefix, and it is still
 *            monotone in S, so subset stability is untouched. At a small scale
 *            the extra plots are ordinary plots the town would not otherwise
 *            have reached — which is precisely what a hoard buys.
 *   charter  the gildhall is INSERTED at roster index countAt(SCALE_MIN) — just
 *            past what the very quietest day would build — and `siteBuilt` is
 *            raised by one. A prefix of length countAt(S) + 1 therefore reaches
 *            it at every scale from 0.25x up.
 *   trinket  nothing.
 *
 * A chest can still outrun the pace control: at 0.25x the finding town may not
 * be founded at all, and a coin hoard's extra plots may fall outside the slice.
 * `grantIds` names the buildings the chest paid for, so the timeline can see
 * exactly which of them survived the trim and narrate at trinket tier when the
 * reward did not make it into the day. Nothing in the map changes; only the
 * story does.
 */
const CHEST_ROAD_CLEAR = 2.5;
const CHEST_RIVER_CLEAR = 3;
const CHEST_SITE_CLEAR = 3;
const CHEST_APART = 12;
/** Chance one buried chest is turned up today. See the harness readout. */
const CHEST_FIND_P = 0.32;

/** Ledger-ready name for the ground a chest is lying in. */
function chestWhere(seed: number, biome: Biome): string {
  if (biome === 'moor') return 'the high moor';
  const ch = woodChar(seed);
  if (ch.boost <= 0) return 'the deep wood';
  const noun: Record<TreeKind, string> = {
    oak: 'the oak wood',
    birch: 'the birch wood',
    fir: 'the fir wood',
    pine: 'the pinewood',
    blossom: 'the blossom wood',
    hedgerow: 'the thickets',
    willow: 'the willow carr',
  };
  return noun[ch.kind] ?? 'the deep wood';
}

interface ChestSite {
  id: string;
  u: number;
  v: number;
  r: number;
}

/** What one town owes a chest it is going to find. */
interface ChestGrant {
  reward: ChestReward;
  /** Extra plots (coin) or 1 (charter). */
  n: number;
  chest: ChestSpec;
}

function buryChests(
  seed: number,
  content: { u0: number; v0: number; u1: number; v1: number },
  river: Pt[],
  chunks: Chunk[],
  sites: ChestSite[],
  nBase: number,
  roadLines: Pt[][]
): { chests: ChestSpec[]; grants: Map<number, ChestGrant> } {
  const chests: ChestSpec[] = [];
  const grants = new Map<number, ChestGrant>();
  if (sites.length < 2) return { chests, grants };
  // Finders come out of the day's BASELINE towns only. `nBase` is drawn from
  // the seed alone, so this is still scale-free — but it means a normal day
  // always reaches the town that gets the windfall, and only the quarter-pace
  // day is ever left narrating a find nobody could act on.
  const finders = clamp(Math.min(nBase, sites.length), 2, sites.length);

  // A derived substream: never the main stream, never the scale.
  const crng = mulberry32((seed ^ 0x63485354) >>> 0); // 'cHST'

  const biomeAt = (p: Pt): Biome => {
    for (const c of chunks) {
      if (p[0] >= c.u0 && p[0] < c.u1 && p[1] >= c.v0 && p[1] < c.v1) return c.biome;
    }
    return 'meadow';
  };

  const roll = crng();
  const n = roll < 0.2 ? 0 : roll < 0.68 ? 1 : 2;

  const placedUV: Pt[] = [];
  for (let k = 0; k < n; k++) {
    /* ---- somewhere nobody has any reason to be --------------------------- */
    let at: Pt | null = null;
    for (let t = 0; t < 4000 && !at; t++) {
      const p: Pt = [
        lerp(content.u0 + 3, content.u1 - 3, crng()),
        lerp(content.v0 + 3, content.v1 - 3, crng()),
      ];
      const biome = biomeAt(p);
      if (biome !== 'forest' && biome !== 'moor') continue;
      if (polyDist(p, river) < CHEST_RIVER_CLEAR) continue;
      let clear = true;
      for (const s of sites) {
        if (dist(p, [s.u, s.v]) < s.r + CHEST_SITE_CLEAR) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      for (const line of roadLines) {
        if (polyDist(p, line) < CHEST_ROAD_CLEAR) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      for (const q of placedUV) {
        if (dist(p, q) < CHEST_APART) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      at = p;
    }
    if (!at) continue;
    placedUV.push(at);

    /* ---- what is in it, and who is going to find it ---------------------- */
    // Four draws, always, whatever the answers turn out to be.
    const tierRoll = crng();
    const siteRoll = crng();
    const coinRoll = crng();
    const findRoll = crng();

    let reward: ChestReward = tierRoll < 0.45 ? 'coin' : tierRoll < 0.65 ? 'charter' : 'trinket';
    // Never sites[0]: the founding house has enough to be getting on with, and
    // its plot count is load-bearing for the rest of the day's pacing.
    const siteIndex = 1 + Math.min(finders - 2, Math.floor(siteRoll * (finders - 1)));
    const found = findRoll < CHEST_FIND_P;
    // One town, one windfall. A second chest aimed at the same place is still a
    // chest — it just turns out to be full of somebody's old buttons.
    if (grants.has(siteIndex)) reward = 'trinket';
    const grantN = reward === 'coin' ? (coinRoll < 0.5 ? 1 : 2) : reward === 'charter' ? 1 : 0;

    const biome = biomeAt(at);
    const [gx, gy] = uv(at[0], at[1]);
    const chest: ChestSpec = {
      id: `ch${chests.length}`,
      gx,
      gy,
      seed: (seed + chests.length * 7919 + 331) >>> 0,
      biome,
      where: chestWhere(seed, biome),
      reward,
      siteIndex,
      siteId: `s${siteIndex}`,
      found,
      grantIds: [],
    };
    chests.push(chest);
    // Only a chest somebody actually opens today pays for anything.
    if (found && grantN > 0) grants.set(siteIndex, { reward, n: grantN, chest });
  }

  return { chests, grants };
}

/* ========================================================================== */
/*  ruins (additive)                                                          */
/* ========================================================================== */

/**
 * Somebody was here before.
 *
 * Nought, one or two sets of overgrown remains, out in the wood, on the moor or
 * in the open meadow — never on a road, never in a green, never in the water or
 * on bare rock, and never on top of a buried chest. They are the one thing in
 * the valley the day does not touch: no crew builds them, no crew pulls them
 * down, and the only line the ledger has about one is that the new lane went
 * past it.
 *
 * ── THE SCALE RULE ────────────────────────────────────────────────────────
 * Ruins are TERRAIN, exactly as chests and lakes are: every field is a pure
 * function of the seed and is byte-identical at 0.25x and at 4x. Nothing below
 * reads `scale`, and every draw comes off a derived substream rather than the
 * main sequence, so adding them moved nothing that was already there.
 *
 * They are sited against the FULL road network and the FULL town roster for
 * the same reason the field fences are: those are what a smaller day is a
 * prefix of, so testing against them is scale-free.
 */
const RUIN_ROAD_CLEAR = 2.2;
const RUIN_RIVER_CLEAR = 2.6;
const RUIN_SITE_CLEAR = 3.5;
const RUIN_LAKE_CLEAR = 1.6;
const RUIN_ROCK_CLEAR = 1.2;
/** A ruin and a chest are two different stories; keep them out of one frame. */
const RUIN_CHEST_CLEAR = 7;
const RUIN_APART = 16;

/** Ledger-ready name for the ground a ruin is standing in. */
function ruinWhere(seed: number, biome: Biome): string {
  if (biome === 'meadow') return 'the open meadow';
  return chestWhere(seed, biome);
}

interface RuinSite {
  u: number;
  v: number;
  r: number;
}

function raiseRuins(
  seed: number,
  content: { u0: number; v0: number; u1: number; v1: number },
  river: Pt[],
  chunks: Chunk[],
  sites: RuinSite[],
  roadLines: Pt[][],
  chests: ChestSpec[],
  offLake: (p: Pt, margin: number) => boolean,
  offRock: (p: Pt, margin: number) => boolean
): RuinSpec[] {
  const ruins: RuinSpec[] = [];
  // A derived substream: never the main stream, never the scale. 'RUIN'.
  const rrng = mulberry32((seed ^ 0x5255494e) >>> 0);

  const biomeAt = (p: Pt): Biome => {
    for (const c of chunks) {
      if (p[0] >= c.u0 && p[0] < c.u1 && p[1] >= c.v0 && p[1] < c.v1) return c.biome;
    }
    return 'meadow';
  };

  // Plenty of seeds get nothing at all: a valley with a ruin in it every single
  // day is a valley with no ruins in it.
  const roll = rrng();
  const n = roll < 0.34 ? 0 : roll < 0.78 ? 1 : 2;

  const placedUV: Pt[] = [];
  for (let k = 0; k < n; k++) {
    /* ---- somewhere nobody has been for a very long time ------------------ */
    let at: Pt | null = null;
    for (let t = 0; t < 4000 && !at; t++) {
      const p: Pt = [
        lerp(content.u0 + 3, content.u1 - 3, rrng()),
        lerp(content.v0 + 3, content.v1 - 3, rrng()),
      ];
      const biome = biomeAt(p);
      if (biome !== 'forest' && biome !== 'moor' && biome !== 'meadow') continue;
      if (polyDist(p, river) < RUIN_RIVER_CLEAR) continue;
      if (offLake(p, RUIN_LAKE_CLEAR)) continue;
      if (offRock(p, RUIN_ROCK_CLEAR)) continue;
      let clear = true;
      for (const s of sites) {
        if (dist(p, [s.u, s.v]) < s.r + RUIN_SITE_CLEAR) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      for (const line of roadLines) {
        if (polyDist(p, line) < RUIN_ROAD_CLEAR) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      for (const c of chests) {
        if (dist(p, [c.gx - c.gy, c.gx + c.gy]) < RUIN_CHEST_CLEAR) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      for (const q of placedUV) {
        if (dist(p, q) < RUIN_APART) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      at = p;
    }
    if (!at) continue;
    placedUV.push(at);

    /* ---- what is left of it ---------------------------------------------- */
    // Three draws, always, whatever the answers turn out to be.
    const kindRoll = rrng();
    const wRoll = rrng();
    const floorRoll = rrng();

    const kind: RuinKind = kindRoll < 0.46 ? 'corner' : kindRoll < 0.72 ? 'tower' : 'rubble';
    const w =
      kind === 'tower'
        ? 28 + Math.floor(wRoll * 3) * 4 // 28 | 32 | 36
        : 28 + Math.floor(wRoll * 5) * 4; // 28 .. 44
    const floors: 1 | 2 | 3 = kind === 'tower' ? 3 : floorRoll < 0.45 ? 2 : 1;

    const biome = biomeAt(at);
    const [gx, gy] = uv(at[0], at[1]);
    ruins.push({
      id: `ru${ruins.length}`,
      gx,
      gy,
      seed: (seed + ruins.length * 6551 + 907) >>> 0,
      kind,
      w,
      floors,
      biome,
      where: ruinWhere(seed, biome),
    });
  }

  return ruins;
}

/* ---- geometry the ghost module reuses, so it cannot drift from this one -- */
/** Distance between two u/v points. */
export const uvDist = dist;
/** Distance from a u/v point to a u/v polyline. */
export const uvPolyDist = polyDist;

/* ========================================================================== */
/*  end ruins (additive)                                                      */
/* ========================================================================== */

/* ========================================================================== */
/*  standing stones (additive)                                                */
/* ========================================================================== */

/**
 * Older than the ruins, and a good deal harder to shift.
 *
 * At most ONE stone monument to a valley, and only ever out on open moor. A
 * seed whose day has no moor chunk in it gets no stones at all, and that is the
 * point: about two valleys in five have one, and the ones that do have the only
 * thing in the map old enough to have named a town.
 *
 * ── THE SCALE RULE ────────────────────────────────────────────────────────
 * The same rule ruins live under: this is TERRAIN. Nothing below reads `scale`,
 * every draw comes off a derived substream rather than the main sequence, and
 * the siting is tested against the FULL road network and the FULL town roster —
 * which are exactly what a smaller day is a prefix of. So the monument is
 * byte-identical at 0.25x and at 4x, and so is the town it named.
 *
 * ── THE MARGIN ────────────────────────────────────────────────────────────
 * The clearances are a shade wider than a ruin's. A ruin is somebody's wall and
 * the lane can run along it; a ring of stones is something the lane goes round.
 */
const STONE_ROAD_CLEAR = 3.2;
const STONE_RIVER_CLEAR = 3;
const STONE_SITE_CLEAR = 3.2;
const STONE_LAKE_CLEAR = 2;
const STONE_ROCK_CLEAR = 1.4;
/** Stones and somebody's walls are two different ages; keep them apart. */
const STONE_RUIN_CLEAR = 10;
/** And a buried chest is a third. */
const STONE_CHEST_CLEAR = 7;
/**
 * How much open ground there can be between the monument and a town's RIM
 * before the town stops being "in sight of the stones". Measured from the rim
 * rather than the centre because the clearance above already keeps the ring off
 * the green, and a centre test would leave a band too narrow to ever land in.
 */
export const STONE_NAME_REACH = 9;

interface StoneSite {
  u: number;
  v: number;
  r: number;
}

/** Where the monument stands, in u/v, alongside the spec the map carries. */
interface StonePlacement {
  spec: StoneSpec;
  u: number;
  v: number;
}

function raiseStones(
  seed: number,
  content: { u0: number; v0: number; u1: number; v1: number },
  river: Pt[],
  chunks: Chunk[],
  sites: StoneSite[],
  roadLines: Pt[][],
  chests: ChestSpec[],
  ruins: RuinSpec[],
  offLake: (p: Pt, margin: number) => boolean,
  offRock: (p: Pt, margin: number) => boolean
): StonePlacement | null {
  // A derived substream: never the main stream, never the scale. 'STON'.
  const srng = mulberry32((seed ^ 0x53544f4e) >>> 0);

  // Three valleys in five never had anybody who built in stone. The roll comes
  // first and unconditionally, so the substream's shape does not depend on
  // whether the map happens to have any moor to put a ring on.
  const wanted = srng() < 0.4;

  // Moor only, and the chunk list is already in a fixed order, so this is a
  // deterministic candidate set. No moor, no stones — that is the scarcity.
  const moor = chunks.filter((c) => c.biome === 'moor');
  if (!wanted || !moor.length) return null;

  const biomeAt = (p: Pt): Biome => {
    for (const c of chunks) {
      if (p[0] >= c.u0 && p[0] < c.u1 && p[1] >= c.v0 && p[1] < c.v1) return c.biome;
    }
    return 'meadow';
  };

  /* ---- somewhere high, dry and useless -------------------------------- */
  let at: Pt | null = null;
  for (let t = 0; t < 3000 && !at; t++) {
    const c = moor[Math.min(moor.length - 1, Math.floor(srng() * moor.length))];
    const p: Pt = [lerp(c.u0 + 1, c.u1 - 1, srng()), lerp(c.v0 + 1, c.v1 - 1, srng())];
    // The chunk grid covers `bounds`, which runs wider than the framed content.
    if (p[0] < content.u0 + 4 || p[0] > content.u1 - 4) continue;
    if (p[1] < content.v0 + 4 || p[1] > content.v1 - 4) continue;
    if (biomeAt(p) !== 'moor') continue;
    if (polyDist(p, river) < STONE_RIVER_CLEAR) continue;
    if (offLake(p, STONE_LAKE_CLEAR)) continue;
    if (offRock(p, STONE_ROCK_CLEAR)) continue;
    let clear = true;
    for (const s of sites) {
      if (dist(p, [s.u, s.v]) < s.r + STONE_SITE_CLEAR) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;
    for (const line of roadLines) {
      if (polyDist(p, line) < STONE_ROAD_CLEAR) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;
    for (const r of ruins) {
      if (dist(p, [r.gx - r.gy, r.gx + r.gy]) < STONE_RUIN_CLEAR) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;
    for (const ch of chests) {
      if (dist(p, [ch.gx - ch.gy, ch.gx + ch.gy]) < STONE_CHEST_CLEAR) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;
    at = p;
  }
  if (!at) return null;

  /* ---- what they put up ------------------------------------------------ */
  // Four draws, always, whatever the answers turn out to be.
  const kindRoll = srng();
  const countRoll = srng();
  const wRoll = srng();
  const fallRoll = srng();

  const kind: StoneKind = kindRoll < 0.42 ? 'circle' : kindRoll < 0.72 ? 'dolmen' : 'row';
  const count = kind === 'circle' ? 5 + Math.floor(countRoll * 3) : kind === 'row' ? 3 + Math.floor(countRoll * 2) : 2;
  // Ring diameter, or the length of the row. A dolmen is two stones and a lid,
  // so it covers a good deal less ground than either.
  const w =
    kind === 'dolmen'
      ? 28 + Math.floor(wRoll * 3) * 4 // 28 | 32 | 36
      : 44 + Math.floor(wRoll * 4) * 4; // 44 .. 56
  // Only a circle has one down: a dolmen with a stone out is a heap, and a row
  // with a gap in it is not a row.
  const fallen = kind === 'circle' ? Math.floor(fallRoll * count) : -1;
  // The ring's turn, and the direction a row marches. Quantised to whole
  // degrees so two monuments that happen to line up share one sprite bake.
  const rot = (Math.round(fallRoll * 360) * Math.PI) / 180;

  const [gx, gy] = uv(at[0], at[1]);
  return {
    spec: {
      id: 'st0',
      gx,
      gy,
      seed: (seed + 4483) >>> 0,
      kind,
      count,
      fallen,
      w,
      rot,
      biome: 'moor',
      where: chestWhere(seed, 'moor'),
    },
    u: at[0],
    v: at[1],
  };
}

/**
 * The town the stones named, or -1.
 *
 * Read off the FULL roster, so which town it is cannot change with the pace —
 * a quiet day may simply never get round to founding it. Nearest rim wins, and
 * the tie-break is the roster index, which is founding order.
 */
function stoneNamesake(sites: StoneSite[], u: number, v: number): number {
  let take = -1;
  let takeD = Infinity;
  for (let i = 0; i < sites.length; i++) {
    const d = dist([sites[i].u, sites[i].v], [u, v]) - sites[i].r;
    if (d < takeD) {
      takeD = d;
      take = i;
    }
  }
  return take >= 0 && takeD <= STONE_NAME_REACH ? take : -1;
}

/* ========================================================================== */
/*  end standing stones (additive)                                            */
/* ========================================================================== */

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

/**
 * Most recent worlds, keyed `seed:scale`. Generation is pure, so a repeat call
 * can hand back the very same object — callers (timeline, scene) treat the map
 * as immutable and never write to it. Insertion order is the LRU order: a hit
 * is deleted and re-inserted so it moves to the young end.
 */
const MAP_CACHE_MAX = 4;
const mapCache = new Map<string, GenesisMap>();

export function generateMap(seed: number, scale = 1): GenesisMap {
  const key = `${seed}:${scale}`;
  const hit = mapCache.get(key);
  if (hit !== undefined) {
    mapCache.delete(key);
    mapCache.set(key, hit);
    return hit;
  }
  const map = buildMap(seed, scale);
  mapCache.set(key, map);
  if (mapCache.size > MAP_CACHE_MAX) {
    const oldest = mapCache.keys().next();
    if (!oldest.done) mapCache.delete(oldest.value);
  }
  return map;
}

/**
 * The same world, built fresh every call and never cached. Only the test
 * harness wants this: a determinism check against `generateMap` would compare
 * an object with itself the moment the cache hits.
 */
export function generateMapUncached(seed: number, scale = 1): GenesisMap {
  return buildMap(seed, scale);
}

function buildMap(seed: number, scale: number): GenesisMap {
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
  // ---- what standing water and bare rock keep to themselves, in u/v -------
  // One table, so "does this system know about lakes?" is a question with a
  // written answer. Roads have their own (ROAD_LAKE_CLEAR, LAKE_ZONE) because
  // they are enforced by the router rather than by rejection sampling.
  /** A town green keeps this much dry land between its rim and a shore … */
  const SITE_LAKE_CLEAR = 2.2;
  /** … and this much soil between its rim and bare rock. Together with
   * QUARRY_REACH that leaves a band a few units wide in which a town is close
   * enough to an outcrop to quarry it without being built on top of it. */
  const SITE_ROCK_CLEAR = 2.5;
  /** A plot never sits on a shore or on a boulder field, at any stage. */
  const PLOT_LAKE_CLEAR = 1.2;
  const PLOT_ROCK_CLEAR = 1.0;
  /** Wood grows to the shore but not into it, and not out of bare stone. */
  const TREE_LAKE_CLEAR = 0.85;
  const TREE_ROCK_CLEAR = 0.5;
  /** Wells, lamps, fences, carts: dressing keeps its feet dry too. */
  const PROP_LAKE_CLEAR = 1.1;
  const PROP_ROCK_CLEAR = 0.8;

  /* ---- lakes and outcrops ---------------------------------------------- */
  // ┌── THE ONE SANCTIONED RESEED ────────────────────────────────────────┐
  // │ These two calls are the only insertion this feature makes into the  │
  // │ main rng stream, and they sit here — after the river, before the    │
  // │ first town — because both of them are terrain the towns have to     │
  // │ keep out of. Everything downstream shifts by their draws, so every  │
  // │ world is a new world as of this commit. That is deliberate and it   │
  // │ happens exactly once: nothing may ever be spliced in above, below   │
  // │ or between these two lines again without the same ceremony.         │
  // └─────────────────────────────────────────────────────────────────────┘
  const lakes = makeLakes(rng, seed, content, river);
  const outcrops = makeOutcrops(rng, seed, content, river, lakes);
  /** Nearest lake shore, signed: negative in the water. */
  const lakeD = (p: Pt) => lakesDist(p, lakes);
  /** Standing water plus its margin is off limits to `what`. */
  const offLake = (p: Pt, margin: number) => lakesWithin(p, lakes, margin);
  /** Bare rock is no place for a roof, a hedge or a well either. */
  const offRock = (p: Pt, margin: number): boolean => {
    for (const o of outcrops) {
      const du = p[0] - o.u;
      const dv = p[1] - o.v;
      const bound = o.radius + margin;
      if (du * du + dv * dv < bound * bound) return true;
    }
    return false;
  };

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
        if (offLake(p, rTry + SITE_LAKE_CLEAR)) continue;
        if (offRock(p, rTry + SITE_ROCK_CLEAR)) continue;
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
          const p: Pt = [u, v];
          let d = polyDist(p, river) - Math.hypot(u, v) * 0.2;
          // Standing water and bare rock count against a spot exactly as the
          // river does, so the insurance sweep never parks the first house on
          // a shore it cannot build on.
          d = Math.min(d, lakeD(p) - SITE_LAKE_CLEAR);
          for (const o of outcrops) {
            d = Math.min(d, dist(p, [o.u, o.v]) - o.radius - SITE_ROCK_CLEAR);
          }
          if (d > best) {
            best = d;
            bestP = p;
          }
        }
      }
      placed = bestP;
      let room = polyDist(bestP, river) - 1.2;
      room = Math.min(room, lakeD(bestP) - SITE_LAKE_CLEAR);
      for (const o of outcrops) {
        room = Math.min(room, dist(bestP, [o.u, o.v]) - o.radius - SITE_ROCK_CLEAR);
      }
      r0 = Math.max(7, Math.min(r0, room));
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
          if (offLake(p, r + SITE_LAKE_CLEAR)) continue;
          if (offRock(p, r + SITE_ROCK_CLEAR)) continue;
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
  /* ---- standing stones (additive) ---- */
  // `townNamesDrawn` is `townNames` with each name's rolls kept alongside it —
  // the same code path and the same draws, so nothing here moved. The rolls are
  // what lets a town by the monument be renamed further down without the
  // naming stream noticing: see `stoneTownName` in names.ts.
  const named = townNamesDrawn(rng, sites.length, usedNames);
  const names = named.map((d) => d.name);
  /* ---- end standing stones (additive) ---- */
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
        if (offLake(p, r + SITE_LAKE_CLEAR)) continue;
        if (offRock(p, r + SITE_ROCK_CLEAR)) continue;
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
    /* ---- standing stones (additive) ---- */
    // Same draws as the `townNames` call this replaced; `named` just keeps the
    // rolls, and stays index-aligned with `names`.
    const more = townNamesDrawn(rng, sites.length - names.length, usedNames);
    named.push(...more);
    names.push(...more.map((d) => d.name));
    /* ---- end standing stones (additive) ---- */
  }
  sites.forEach((s, i) => {
    s.id = `s${i}`;
    s.accent = pool[i % pool.length];
    s.name = names[i];
  });

  /** How many of the roster actually get founded today. */
  const nSites = clamp(Math.round(nBase * siteFactor(S)), 2, sites.length);

  /**
   * The outcrop each town quarries, or null. Read off the FULL roster and the
   * terrain alone, so a town is a quarry town at every pace or at none — which
   * is what lets everything downstream of it (walls, roofs, the stone yard, the
   * bridges its roads carry, its lamps and its field walls) be chosen as a pure
   * function of it, without a single extra draw from any stream.
   */
  const siteQuarry = sites.map((s) => quarriesFrom(s.u, s.v, s.r, outcrops));

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

  const grid = buildRouteGrid(content, river, lakes);
  const roads: RoadSpec[] = [];
  const bridges: BridgeSpec[] = [];
  const fords: FordSpec[] = [];
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

    // A* kept the route out of the water; the smoothing above and the bridge
    // straightener below both cut corners, and the corner a lakeside road turns
    // is the lake. Correct the polyline rather than the router: a graded cost
    // high enough to survive Chaikin would push roads a silly distance out.
    line = pushOutOfLakes(bridgeRoad(line, river), lakes, ROAD_LAKE_CLEAR);
    line = densify(line, 3.0, 0.4);
    // Through-roads. s0 keeps a wider berth because its founding house sits on
    // the exact centre; elsewhere the green is empty and the street can run
    // right in. Bridges and arclength fracs are both derived below, from the
    // final polyline, so the extra length is accounted for automatically.
    line = extendIntoTown(line, pa, a === 0 ? 2.1 : 1.4, true);
    line = extendIntoTown(line, pb, b === 0 ? 2.1 : 1.4, false);
    // The through-road Bezier can bulge off the radial on its way in; the town
    // green itself is clear of the water, but the bulge is not guaranteed to be.
    line = pushOutOfLakes(line, lakes, ROAD_LAKE_CLEAR);

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
    // Every crossing carries exactly one of the two, and which one is decided
    // by the road class alone — no rng, so the main stream is untouched. A
    // highway or a lane has carts on it and gets a bridge; a track is a line
    // of footfall and a pack pony, and it simply goes through the water.
    // Both towns quarry, so the masons are at both ends of the job and there is
    // nobody left who would rather have planks. Decided once per road.
    const stoneEnds = siteQuarry[a] !== null && siteQuarry[b] !== null;
    for (const p of crossings(line, river)) {
      const [cgx, cgy] = uv(p[0], p[1]);
      if (kind === 'track') {
        fords.push({ id: `fd${fords.length}`, roadId: id, gx: cgx, gy: cgy, span: 3.4 });
      } else {
        // …or the crossing itself comes up beside bare rock, in which case the
        // material is lying on the bank and only a fool would cart timber to it.
        // Both tests are pure functions of the full roster and the terrain, so
        // the material costs no draw and is the same at every pace.
        let rock = Infinity;
        for (const o of outcrops) rock = Math.min(rock, dist(p, [o.u, o.v]) - o.radius);
        const stone = stoneEnds || rock <= STONE_BRIDGE_REACH;
        bridges.push({
          id: `br${bridges.length}`,
          roadId: id,
          gx: cgx,
          gy: cgy,
          span: 4.2,
          ...(stone ? { material: 'stone' as const } : null),
        });
      }
    }
  });

  // Both ends of edge `ei` are roster indices <= the town it serves, and the
  // edges are emitted in roster order, so the roads a smaller scale keeps are
  // exactly a prefix of this array — and likewise the bridges hung off them.
  const roadCount = edges.filter(([a, b]) => Math.max(a, b) < nSites).length;
  const activeRoads = roads.slice(0, roadCount);
  const activeRoadIds = new Set(activeRoads.map((r) => r.id));
  const activeBridges = bridges.filter((b) => activeRoadIds.has(b.roadId));
  // Fords are hung off the roads exactly as the bridges are, and their ids are
  // handed out in the same edge order, so they are a prefix for the same reason.
  const activeFords = fords.filter((f) => activeRoadIds.has(f.roadId));

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
      // A lake wets the ground around it exactly as the river does, which is
      // what puts willows and reeds on a shore without a single special case
      // further down. Bare rock does the opposite: moor, whatever else it is.
      const nearLake = lakeD(c);
      let nearRock = Infinity;
      for (const o of outcrops) nearRock = Math.min(nearRock, dist(c, [o.u, o.v]) - o.radius);

      let biome: Biome = 'meadow';
      if (nearRiver < 5.5 || nearLake < 4.5) biome = 'wetland';
      else if (nearRock < 3.5) biome = 'moor';
      else if (nearSite < 6) biome = 'farm';
      else if (edge > 0.8) biome = 'forest';
      // Open moor: the dry high ground a long way from both the water and the
      // nearest holding, where nothing was ever cleared because nothing ever
      // grew. Sparse, rocky, no farms. Keyed to the same seeded lattice as the
      // forest patches so it is a pure function of the seed, and tested after
      // the map-edge forest so the border still reads as deep wood.
      else if (nearRiver > 9.5 && nearSite > 8.5 && (i * 5 + j * 11 + (seed % 7)) % 3 === 0)
        biome = 'moor';
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

  /* ---- buried treasure --------------------------------------------------- */
  // Terrain, and drawn from its own substream — see buryChests above for the
  // scale rule. It has to run here, after the chunks and the FULL road network
  // and before the buildings, because a chest that gets found pays for plots.
  const { chests, grants: chestGrants } = buryChests(
    seed,
    content,
    river,
    chunks,
    sites,
    nBase,
    roadLines
  );

  /* ---- ruins (additive) -------------------------------------------------- */
  // Terrain, on its own substream — see raiseRuins above for the scale rule.
  // It runs here, after the chunks, the FULL road network and the chests it has
  // to keep clear of, and before the trees, because the wood grows up to a wall
  // and not through it (the clearance pass sits with the chests' one below).
  const ruins = raiseRuins(
    seed,
    content,
    river,
    chunks,
    sites,
    roadLines,
    chests,
    offLake,
    offRock
  );
  /* ---- end ruins (additive) ---------------------------------------------- */

  /* ---- standing stones (additive) ---------------------------------------- */
  // Terrain, on its own substream — see raiseStones above for the scale rule.
  // It runs here for the reasons the ruins do (after the chunks, the FULL road
  // network, the chests and the walls it keeps clear of; before the trees, so
  // the ring is bare ground) and for one of its own: nothing below this line
  // has read a town's NAME yet, so the monument can still rename one.
  const placement = raiseStones(
    seed,
    content,
    river,
    chunks,
    sites,
    roadLines,
    chests,
    ruins,
    offLake,
    offRock
  );
  const stones: StoneSpec[] = [];
  if (placement) {
    const take = stoneNamesake(sites, placement.u, placement.v);
    if (take >= 0) {
      // Not a new draw and not a reordering — the same rolls that town's
      // ordinary name came off, looked up in the stone-flavoured pools. Every
      // other town keeps the name it already had, down to the last letter.
      const was = sites[take].name;
      usedNames.delete(was);
      const now = stoneTownName(named[take].rolls, usedNames, was);
      usedNames.add(now);
      sites[take].name = now;
      names[take] = now;
      placement.spec.townId = sites[take].id;
      placement.spec.townName = now;
    }
    stones.push(placement.spec);
  }
  /* ---- end standing stones (additive) ------------------------------------ */

  /* ---- trees ------------------------------------------------------------ */
  // ┌── WHY THE WOOD IS PLANTED HERE, ABOVE THE ROOFS ───────────────────┐
  // │ founders and professions (additive). A town's trade is read off    │
  // │ the ground it was founded on, and one of the things that ground    │
  // │ has on it is trees — so the wild wood has to exist before the      │
  // │ first plot is rolled.                                              │
  // │                                                                    │
  // │ Moving it costs nothing. Every one of the three planting passes    │
  // │ below draws from its OWN substream (per chunk, per site, per road) │
  // │ and takes not a single number off the main `rng`, so the whole     │
  // │ block commutes with the buildings block: the maps this generator   │
  // │ produced before the move are byte-identical to the ones it         │
  // │ produces after it. The `clears` passes stay where they were, below │
  // │ the roofs, because those genuinely do need the plots.              │
  // └────────────────────────────────────────────────────────────────────┘
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
    moor: 0.035,
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
  // The day's woodland, re-weighted by the seed's forest character (see
  // WOOD_CHARACTERS): the base mix per biome, then one kind pushed to the
  // front so one valley reads birch-bright and the next fir-dark. Weights are
  // normalised, and the choice is made from a derived substream, so nothing
  // about it depends on the pace scale.
  const TREE_KINDS = woodland(seed);

  const trees: TreeSpec[] = [];
  const treeUV: Pt[] = [];
  let treeId = 0;

  // Trees may now stand ON a planned road — the crews fell them as they build
  // (see the road `clears` pass below). Only the water and the rock push back.
  const treeClear = (p: Pt): boolean =>
    polyDist(p, river) >= 1.5 && !offLake(p, TREE_LAKE_CLEAR) && !offRock(p, TREE_ROCK_CLEAR);

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
  /**
   * Conservative superset of the tree indices within `r` of (u, v), read off
   * the same 1-unit hash grid the spacing test uses. Callers still apply the
   * exact distance test, so a superset is safe; what a caller must NOT assume
   * is grid order, hence the ascending sort — it restores the original
   * tree-array iteration order for every scan below.
   */
  const treesNear = (u: number, v: number, r: number): number[] => {
    const out: number[] = [];
    const cu0 = Math.floor(u - r);
    const cu1 = Math.floor(u + r);
    const cv0 = Math.floor(v - r);
    const cv1 = Math.floor(v + r);
    for (let cu = cu0; cu <= cu1; cu++) {
      for (let cv = cv0; cv <= cv1; cv++) {
        const bucket = cells.get(cellKey(cu, cv));
        if (bucket) for (const k of bucket) out.push(k);
      }
    }
    out.sort((a, b) => a - b);
    return out;
  };

  /** Same, for the cells within `r` of any segment of `line`. Deduped. */
  const treesNearLine = (line: Pt[], r: number): number[] => {
    const keys = new Set<number>();
    const out: number[] = [];
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      const cu0 = Math.floor(Math.min(a[0], b[0]) - r);
      const cu1 = Math.floor(Math.max(a[0], b[0]) + r);
      const cv0 = Math.floor(Math.min(a[1], b[1]) - r);
      const cv1 = Math.floor(Math.max(a[1], b[1]) + r);
      for (let cu = cu0; cu <= cu1; cu++) {
        for (let cv = cv0; cv <= cv1; cv++) {
          const key = cellKey(cu, cv);
          if (keys.has(key)) continue;
          keys.add(key);
          const bucket = cells.get(key);
          if (bucket) for (const k of bucket) out.push(k);
        }
      }
    }
    out.sort((a, b) => a - b);
    return out;
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

  /* ============ founders and professions (additive block) ================ *
   * Placed exactly here, between the WILD wood and the two planted passes
   * below it, because "founded in thick forest" has to mean the forest that
   * was already standing — not the grove the town will clear out of its own
   * green, and not the corridor trees a road brought with it. At this point
   * `trees` holds the chunk pass and nothing else, which is the wild wood.
   *
   * Everything below is a pure function of the FULL roster and the terrain:
   * no main-`rng` draw, no `nSites`, no `S`. So a town has the same founder
   * and the same trade at 0.25x as it has at 4x, and the pace control can
   * only decide whether that town is reached today at all.
   * ----------------------------------------------------------------------- */

  /** Whoever drove the first stake, per roster index. Own substream. */
  const founders = founderNames(seed, sites.length);

  const siteProfession: Profession[] = sites.map((site, si) => {
    // The founding homestead is the whole valley in one yard: it fishes, fells
    // and ploughs, so it is not any one of them.
    if (si === 0) return 'plain';
    const p: Pt = [site.u, site.v];

    // Water first: a rim within FISH_REACH of the river bank or a lake shore.
    // Measured rim-to-water like QUARRY_REACH and JETTY_REACH, so it means the
    // same thing for a big town and a small one — and it is deliberately the
    // same geography that earns a town a jetty, so the two agree far more often
    // than they disagree.
    const water = Math.min(polyDist(p, river) - riverWidth * Math.SQRT2, lakeD(p)) - site.r;
    if (water <= FISH_REACH) return 'fishing';

    // Then wood: how much wild forest was standing within LOG_REACH of the
    // green before anybody put an axe in it.
    let wild = 0;
    for (const i of treesNear(p[0], p[1], LOG_REACH)) {
      if (dist(treeUV[i], p) <= LOG_REACH) wild++;
    }
    if (wild >= LOG_TREES) return 'logging';

    // Then plough: farm chunks whose centre lies within FARM_REACH of the rim.
    let fields = 0;
    for (const c of chunks) {
      if (c.biome !== 'farm') continue;
      const cu = (c.u0 + c.u1) / 2;
      const cv = (c.v0 + c.v1) / 2;
      if (dist(p, [cu, cv]) - site.r <= FARM_REACH) fields++;
    }
    if (fields >= FARM_CHUNKS) return 'farming';

    return 'plain';
  });

  /* ========== end founders and professions (additive block) ============== */

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

  /* ---- buildings -------------------------------------------------------- */
  const GOLDEN = 2.399963;
  const siteBuildings: BuildingSpec[][] = [];
  const siteBuilt: number[] = [];
  /** Plots the town would reach at the baseline pace, and at the busiest. */
  const siteBuiltBase: number[] = [];
  const siteBuiltMax: number[] = [];

  sites.forEach((site, si) => {
    const brng = mulberry32((seed * 7919 + si * 104729 + 17) >>> 0);
    const stone = siteQuarry[si] !== null;
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

    /* ---- what a chest bought this town, if anything -------------------- */
    // The one sanctioned way the roster grows beyond the pace ladder. Both
    // branches keep `siteBuilt` a monotone prefix length — see buryChests.
    const grant = chestGrants.get(si);
    const extra = grant ? grant.n : 0;
    // Whatever a chest buys goes in just past the quietest day's roster, so it
    // is inside the prefix at every scale from 0.25x up. A prefix of length
    // countAt(S) + extra always reaches index countAt(SCALE_MIN) + extra - 1.
    const grantAt = grant ? Math.min(countAt(SCALE_MIN), maxCount) : -1;
    const gildAt = grant && grant.reward === 'charter' ? grantAt : -1;
    const total = maxCount + extra;

    siteBuilt.push(Math.min(total, countAt(S) + extra));
    siteBuiltBase.push(countAt(1) + extra);
    siteBuiltMax.push(total);
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
          // Water and bare rock never relax across the stages: a plot on a
          // shore or on a boulder field is not a tight plot, it is a wrong one.
          if (offLake(p, r + PLOT_LAKE_CLEAR)) continue;
          if (offRock(p, r + PLOT_ROCK_CLEAR)) continue;
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
          if (offLake(p, r + PLOT_LAKE_CLEAR)) continue;
          if (offRock(p, r + PLOT_ROCK_CLEAR)) continue;
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

    for (let i = 0; i < total; i++) {
      const founding = si === 0 && i === 0;
      const landmark = founding ? false : (si === 0 ? i === 1 : i === 0);
      const gild = i === gildAt;

      let role: StructureRole;
      let w: number;
      let floors: 1 | 2 | 3;
      if (founding) {
        role = 'homestead';
        w = 40 + Math.floor(brng() * 3) * 4; // 40 | 44 | 48
        floors = 2;
      } else if (gild) {
        // A charter buys one building nothing else in the valley can be: gold
        // ridge trim, a banner, and a floor more than it strictly needs.
        role = 'gildhall';
        w = clamp(Math.round((baseW * 1.4) / 4) * 4, 44, 60);
        floors = brng() < 0.6 ? 3 : 2;
      } else if (landmark) {
        role = LANDMARK_ROLES[(si + landmarkOffset) % LANDMARK_ROLES.length];
        w = clamp(Math.round((baseW * 1.5) / 4) * 4, 44, 64);
        floors = brng() < 0.45 ? 3 : 2;
      } else {
        // founders and professions (additive): the SAME single draw, read
        // through the bag this town's trade keeps. See PROFESSION_ROLES.
        //
        // Worth knowing, because it is not obvious: the `roof` ternary below
        // spends a SECOND draw when a thatchable role rolls out of thatch, so
        // the plot loop's draw count has always been a function of the role.
        // Changing which role a given number lands on therefore moves the
        // plots inside a green, and it is why this commit is a new set of
        // worlds. It does not touch subset stability, and cannot: a town's
        // trade is read off the FULL roster, so the sequence is the same
        // sequence at 0.25x as at 4x. The pace ladder is unaffected; only
        // yesterday's screenshots are.
        role = pick(brng, PROFESSION_ROLES[siteProfession[si]]);
        w = clamp(Math.round((baseW * (0.78 + brng() * 0.4)) / 4) * 4, 24, 52);
        floors = brng() < 0.34 ? 2 : 1;
      }

      const p = founding ? ([site.u, site.v] as Pt) : place(i, fpR(w));
      // Thatch never goes on stone: a quarry town roofs in slate, and the
      // `!stone` short-circuit means it never spends the thatch roll either.
      const roof: RoofStyle = founding
        ? 'gable'
        : !stone && THATCH_ROLES.has(role) && brng() < 0.72
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
        chimney:
          founding ||
          role === 'smithy' ||
          role === 'bakery' ||
          role === 'brewhouse' ||
          role === 'cottage' ||
          role === 'house' ||
          brng() < 0.35,
        awning: role === 'store' || (role === 'workshop' && brng() < 0.5),
        banner: founding || landmark || gild,
        cupola: role === 'chapel' || (role === 'tower' && brng() < 0.6),
        accent: site.accent,
        seed: (seed + si * 7717 + i * 613) >>> 0,
        clears: [],
        // Set on the FULL roster, so it cannot appear or vanish with the pace.
        // Left off entirely for a timber town: absent IS 'timber', and writing
        // it out would only churn every existing world's JSON.
        ...(stone ? { material: 'stone' as const } : null),
      });
    }
    // Name the buildings this chest paid for, so the timeline can tell at a
    // glance which of them survived the day's pace trim — and can put the
    // discovery in the ledger before the town starts spending. Ids come off the
    // FULL roster at a scale-free index, so the list is the same at every pace.
    if (grant) {
      grant.chest.grantIds = list.slice(grantAt, grantAt + extra).map((b) => b.id);
    }

    siteBuildings.push(list);
  });

  const allBuildings = siteBuildings.flat();

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
    for (const i of treesNear(fu, fv, clearR)) {
      if (dist(treeUV[i], [fu, fv]) < clearR) dead.add(trees[i].id);
    }
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
    // Only trees in the grid cells straddling the route can be within
    // ROAD_CLEAR of it; the exact per-segment scan below is unchanged, so the
    // surviving set — and therefore the sort that orders it — is identical.
    for (const i of treesNearLine(line, ROAD_CLEAR)) {
      const t = trees[i];
      if (dead.has(t.id) || roadClaimed.has(t.id)) continue;
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
      if (bd >= ROAD_CLEAR) continue;
      roadClaimed.add(t.id);
      list.push({ tree: t.id, frac: clamp(bs / total, 0, 1) });
    }
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
    for (const i of treesNear(bu, bv, r)) {
      const t = trees[i];
      // First claimant wins — roads before plots, and among plots whichever
      // was surveyed first. One tree, one axe.
      if (dead.has(t.id) || roadClaimed.has(t.id) || protectedTrees.has(t.id)) continue;
      const d = dist(treeUV[i], [bu, bv]);
      if (d < r) cand.push({ id: t.id, d });
    }
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
    // Open moor: stone and low scrub, and never a farm animal.
    moor: [['rock', 0.42], ['bush', 0.34], ['stump', 0.12], ['flowers', 0.12]],
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

  /* ---- lake shores and outcrop boulders --------------------------------- */
  // Both are TERRAIN dressed onto the wild scatter list: derived from the
  // lakes/outcrops and a per-feature substream, never from the pace, so they
  // stay byte-identical at every scale exactly as the rest of `scatter` does.
  {
    /**
     * The road segments that could come within `pad` of a box around (u, v).
     * Everything below works one feature at a time inside a small box, so the
     * whole network is trimmed once per feature rather than walked per
     * candidate — the same trick the site dressing plays with `segsNearBox`.
     */
    const roadSegsAround = (u: number, v: number, reach: number, pad: number): Pt[][] => {
      const out: Pt[][] = [];
      for (const line of roadLines) {
        for (const s of segsNearBox(line, u - reach, v - reach, u + reach, v + reach, pad)) {
          out.push(s);
        }
      }
      return out;
    };
    /** Free ground for a wild prop: off the roads, out of the greens, spaced. */
    const wildOk = (p: Pt, gap: number, roadSegs: Pt[][]): boolean => {
      if (p[0] < bounds.u0 + 1 || p[0] > bounds.u1 - 1) return false;
      if (p[1] < bounds.v0 + 1 || p[1] > bounds.v1 - 1) return false;
      for (const s of sites) if (dist(p, [s.u, s.v]) < s.r + 1) return false;
      if (anySegWithin(p, roadSegs, 1.1)) return false;
      for (const q of scatterUV) if (dist(p, q) < gap) return false;
      return true;
    };
    /**
     * Undergrowth gives way, exactly as it does to a fence — but only wild
     * undergrowth. A tree somebody is already coming to fell keeps its
     * appointment and the prop goes somewhere else.
     */
    const takeGround = (p: Pt, r: number): boolean => {
      const hits: number[] = [];
      for (const i of treesNear(p[0], p[1], r)) {
        if (dist(treeUV[i], p) >= r) continue;
        if (protectedTrees.has(trees[i].id) || roadClaimed.has(trees[i].id)) return false;
        hits.push(i);
      }
      for (const i of hits) dead.add(trees[i].id);
      return true;
    };
    const addWild = (kind: string, p: Pt, s: number) => {
      const [gx, gy] = uv(p[0], p[1]);
      scatter.push({ id: `pr${scatter.length}`, kind, gx, gy, seed: s >>> 0 });
      scatterUV.push(p);
    };

    // A reed-and-boulder collar just outside the water line. Reeds carry it —
    // a shore that is all rock reads as a quarry, and the wetland biome the
    // lake imposes has already put willows behind them.
    const SHORE_KINDS: [string, number][] = [
      ['reeds', 0.52], ['rock', 0.18], ['bush', 0.16], ['flowers', 0.14],
    ];
    for (const l of lakes) {
      const lrng = mulberry32((l.seed ^ 0x51ac3e17) >>> 0);
      const meanR = l.mean;
      const nearRoads = roadSegsAround(l.u, l.v, l.maxR + 2.2, 1.1);
      const perim = Math.PI * (l.rx + l.ry);
      const target = Math.max(5, Math.round(perim * 0.6));
      const a0 = lrng() * Math.PI * 2;
      for (let i = 0; i < target; i++) {
        const a = a0 + (i / target) * Math.PI * 2 + (lrng() - 0.5) * 0.22;
        const off = 0.55 + lrng() * 1.15;
        const k = 1 + off / meanR;
        const rr = lakeShape(l, a) * k;
        const x = Math.cos(a) * l.rx * rr;
        const y = Math.sin(a) * l.ry * rr;
        const c = Math.cos(l.rot);
        const s = Math.sin(l.rot);
        const p: Pt = [l.u + x * c - y * s, l.v + x * s + y * c];
        const kind = rollKind(lrng(), SHORE_KINDS);
        if (lakeD(p) < 0.35) continue; // the wobble undershot; that one is water
        if (polyDist(p, river) < 1.2) continue;
        if (!wildOk(p, 1.05, nearRoads)) continue;
        if (!takeGround(p, 0.9)) continue;
        addWild(kind, p, l.seed + i * 149);
      }
    }

    // The rock itself: a boulder field, tighter than anything the wild scatter
    // lays down, with a little scrub caught between the stones.
    const ROCK_KINDS: [string, number][] = [
      ['rock', 0.72], ['bush', 0.16], ['stump', 0.07], ['flowers', 0.05],
    ];
    for (const o of outcrops) {
      const orng = mulberry32((o.seed ^ 0x2b7f4d91) >>> 0);
      const nearRoads = roadSegsAround(o.u, o.v, o.radius + 1.2, 1.1);
      const target = Math.round(Math.PI * o.radius * o.radius * 0.62);
      let placed = 0;
      for (let t = 0; t < target * 8 && placed < target; t++) {
        const a = orng() * Math.PI * 2;
        const rad = Math.sqrt(orng()) * o.radius;
        const p: Pt = [o.u + Math.cos(a) * rad, o.v + Math.sin(a) * rad];
        const kind = rollKind(orng(), ROCK_KINDS);
        if (!wildOk(p, 0.62, nearRoads)) continue;
        if (!takeGround(p, 0.55)) continue;
        addWild(kind, p, o.seed + t * 211);
        placed++;
      }
    }
  }

  /* ---- field fences along the farm lanes -------------------------------- */
  // Farmland with a lane through it gets a run of picket fence set back from
  // the carriageway, so the road reads as running between fields instead of
  // across open green. This is terrain, not dressing: it is derived from the
  // FULL road network and a substream of the seed, never from the pace, so it
  // stays byte-identical at every scale.
  //
  // A run steps along whichever isometric diagonal the lane is closest to,
  // because that is the only direction the fence sprite is drawn in; a run laid
  // on the road's exact bearing would be a staircase of disconnected panels.
  {
    const frng = mulberry32((seed ^ 0x1d3a5f77) >>> 0);
    /** One fence panel spans this far in u and in v (34 art px / TW tiles). */
    const PANEL = 34 / TW;
    /** How much green a panel keeps to itself. */
    const FENCE_CLEAR = 1.0;
    const biomeAt = (p: Pt): Biome => {
      for (const c of chunks) {
        if (p[0] >= c.u0 && p[0] < c.u1 && p[1] >= c.v0 && p[1] < c.v1) return c.biome;
      }
      return 'meadow';
    };
    /** Roster index of the town whose ground this is. FULL roster, always. */
    const nearestSite = (p: Pt): number => {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < sites.length; i++) {
        const d = dist(p, [sites[i].u, sites[i].v]);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    };
    const fenceOk = (p: Pt): boolean => {
      if (p[0] < bounds.u0 + 1 || p[0] > bounds.u1 - 1) return false;
      if (p[1] < bounds.v0 + 1 || p[1] > bounds.v1 - 1) return false;
      if (biomeAt(p) !== 'farm') return false;
      if (polyDist(p, river) < 1.8) return false;
      if (offLake(p, PROP_LAKE_CLEAR + 0.6)) return false;
      if (offRock(p, PROP_ROCK_CLEAR)) return false;
      for (const s of sites) if (dist(p, [s.u, s.v]) < s.r + 0.8) return false;
      for (const l of roadLines) if (polyDist(p, l) < 1.35) return false;
      // Undergrowth gives way to the fence, exactly as it does to a well — but
      // only wild undergrowth. A tree somebody is already coming to fell keeps
      // its appointment, so the fence goes somewhere else.
      for (const i of treesNear(p[0], p[1], FENCE_CLEAR)) {
        if (dist(treeUV[i], p) >= FENCE_CLEAR) continue;
        if (protectedTrees.has(trees[i].id) || roadClaimed.has(trees[i].id)) return false;
      }
      for (const q of scatterUV) if (dist(p, q) < 1.3) return false;
      return true;
    };

    const RUNS = 5;
    let runs = 0;
    for (let attempt = 0; attempt < 400 && runs < RUNS; attempt++) {
      if (!roadLines.length) break;
      const line = roadLines[Math.floor(frng() * roadLines.length)];
      const cum = cumulative(line);
      const total = cum[cum.length - 1] || 1;
      const at = pointAtS(line, cum, frng() * total);
      const near = polyNear(at, line);
      // Nearest isometric diagonal to the lane: (1,1) is +gx, (-1,1) is +gy.
      const alongGx = Math.abs(near.tu + near.tv) >= Math.abs(near.tv - near.tu);
      const sgn =
        (alongGx ? near.tu + near.tv : near.tv - near.tu) >= 0 ? 1 : -1;
      const step: Pt = alongGx
        ? [sgn * PANEL, sgn * PANEL]
        : [-sgn * PANEL, sgn * PANEL];
      const side = frng() < 0.5 ? 1 : -1;
      const off = 1.7 + frng() * 0.5;
      const n = 3 + Math.floor(frng() * 2);
      const start: Pt = [
        at[0] - near.tv * off * side - (step[0] * (n - 1)) / 2,
        at[1] + near.tu * off * side - (step[1] * (n - 1)) / 2,
      ];
      const run: Pt[] = [];
      for (let k = 0; k < n; k++) {
        const p: Pt = [start[0] + step[0] * k, start[1] + step[1] * k];
        if (!fenceOk(p)) break;
        run.push(p);
      }
      if (run.length < 3) continue;
      run.forEach((p, k) => {
        const [gx, gy] = uv(p[0], p[1]);
        // A field boundary takes after the town whose field it is: a quarry
        // town walls its ground in the stone already lying about, a meadow town
        // splits timber for it. Read per PANEL, off the FULL roster — the same
        // list the quarry-ness itself is read off — so it is a pure function of
        // the terrain: no draw is spent on it, the stream shape is untouched,
        // and a run that happens to cross the ground between a stone town and a
        // timber one changes hands halfway along, which is what a boundary
        // between two parishes has always looked like.
        const dry = siteQuarry[nearestSite(p)] !== null;
        scatter.push({
          id: `pr${scatter.length}`,
          kind: alongGx ? (dry ? 'drystoneL' : 'fenceL') : (dry ? 'drystoneR' : 'fenceR'),
          gx,
          gy,
          seed: (seed + runs * 1741 + k * 59) >>> 0,
        });
        scatterUV.push(p);
        for (const i of treesNear(p[0], p[1], FENCE_CLEAR)) {
          if (dist(treeUV[i], p) < FENCE_CLEAR) dead.add(trees[i].id);
        }
      });
      runs++;
    }
  }

  /* ---- boats out on the open water -------------------------------------- *
   * ADDITIVE BLOCK — boats and jetties.
   *
   * A lake with any size to it usually has a boat adrift on it that belongs to
   * nobody in particular. These are TERRAIN, not dressing: they come out of a
   * substream of the seed and the lake shapes alone, never out of the roster or
   * the pace, so `scatter` stays byte-identical at every scale — which is what
   * the harness's terrain check demands of it.
   *
   * They are appended after every other scatter pass, so no earlier rejection
   * sampler can see them and no existing prop moves because of them.
   * ------------------------------------------------------------------------ */
  {
    const brng = mulberry32((seed ^ 0x5eab1703) >>> 0);
    /** Water this far inside the shore is open water, not the margin. */
    const OPEN = 1.5;
    /** Keep well clear of the bank any town would put its own jetty on. This is
     * lake water, so it is the LAKE reach that decides how far that is. */
    const OFF_TOWN = JETTY_LAKE_REACH + 1.5;
    let afloat = 0;
    /** Two boats adrift in the same square yard read as one accident. */
    const moored: Pt[] = [];
    for (const l of lakes) {
      if (afloat >= 2) break;
      // Only a lake with room to row on. The roll happens for every big lake
      // whether or not the boat lands, so the stream does not depend on luck.
      const roll = brng();
      const dirRoll = brng();
      const seedRoll = brng();
      if (l.mean < 3.2 || roll > 0.72) continue;
      for (let t = 0; t < 40; t++) {
        const a = brng() * Math.PI * 2;
        const rad = Math.sqrt(brng());
        const p: Pt = [l.u + Math.cos(a) * l.rx * rad, l.v + Math.sin(a) * l.ry * rad];
        if (lakeDist(p, l) > -OPEN) continue;
        if (polyDist(p, river) < 1.2) continue;
        let crowded = false;
        for (const s of sites) {
          if (dist(p, [s.u, s.v]) < s.r + OFF_TOWN) {
            crowded = true;
            break;
          }
        }
        if (crowded) continue;
        if (moored.some((q) => dist(p, q) < 3)) continue;
        moored.push(p);
        const [gx, gy] = uv(p[0], p[1]);
        scatter.push({
          id: `pr${scatter.length}`,
          kind: 'rowboat',
          gx,
          gy,
          seed: (l.seed + 9173 + afloat * 811) >>> 0,
          dir: dirRoll * Math.PI * 2,
        });
        // Deliberately NOT pushed to `scatterUV`: that index is a land-spacing
        // structure and a boat is not on the land.
        afloat++;
        // A second boat on the same water, now and then.
        if (afloat < 2 && seedRoll < 0.34) continue;
        break;
      }
    }
  }

  /* ---- site dressing ---------------------------------------------------- */
  // Dressing is the one place the pace control is allowed to change what a
  // town CONTAINS rather than only how many plots it reaches — a town that
  // built twelve roofs today should not be wearing the same three barrels as
  // the same town on a quarter-pace day.
  //
  // It stays subset-stable because the list is built in two blocks: the
  // essentials (well, nameboard, lamps, and the junction / camp / timber
  // pieces that follow from the roster) always come first, then the flavour
  // tail, and only the LENGTH of that tail depends on the day's build count.
  // Every position, id and seed is computed against the full roster, so a
  // smaller scale is a strict prefix of a larger one.
  //
  // How many roads meet at each town, over the FULL road network: a crossroads
  // is a property of the roster, so it is a crossroads at every pace.
  const roadDegree = new Array<number>(sites.length).fill(0);
  for (const [a, b] of edges) {
    roadDegree[a]++;
    roadDegree[b]++;
  }
  /** Trees this town's plots have to fell, over the full plot roster. */
  const siteTimber = siteBuildings.map((list) => list.reduce((n, b) => n + b.clears.length, 0));
  /** How much of each site's dressing today's pace actually reaches. */
  const sitePropCount: number[] = [];

  /* ---- where a town would put a jetty ----------------------------------- *
   * ADDITIVE BLOCK — boats and jetties.
   *
   * Every other piece of dressing is placed by `ok()`, which REJECTS water. A
   * jetty is the one thing that wants to straddle the line: rooted on the bank,
   * decked out over the water. So it does not go through `ok()` at all. It
   * finds the bank explicitly instead:
   *
   *   1. aim at the nearest water — the river's centreline or a lake's middle;
   *   2. march out along that bearing until the signed distance to open water
   *      changes sign, then bisect for the crossing: that is the bank point;
   *   3. take the bank's own normal there, from the numeric gradient of the
   *      same signed distance, so the deck is square to the shore rather than
   *      square to whatever direction the town happened to be lying in;
   *   4. root the deck JETTY_ROOT up the bank and run it JETTY_LEN out, and
   *      insist the head of it is genuinely wet.
   *
   * If any of that fails — no water in reach, a roof in the way, a shore too
   * shallow to reach past — the town simply has no jetty, which is most of the
   * point. Swinging the aim a few times either way slides the bank point along
   * the shore, which is how a jetty gets out from under a building.
   * ------------------------------------------------------------------------ */
  const riverHalf = riverWidth * Math.SQRT2;

  const jettyFor = (
    site: (typeof sites)[number],
    si: number
  ): { root: Pt; dir: number; len: number } | null => {
    const S: Pt = [site.u, site.v];
    const span = site.r + JETTY_LAKE_REACH + JETTY_LEN + 2;
    const segs = segsNearBox(river, S[0] - span, S[1] - span, S[0] + span, S[1] + span, 0.5);
    const near = lakes.filter((l) => dist(S, [l.u, l.v]) < span + l.maxR);
    if (!segs.length && !near.length) return null;

    /** Signed distance to open water, u/v: negative in it, positive on land. */
    const sd = (p: Pt): number => {
      let best = Infinity;
      for (const s of segs) {
        const d = segDist(p, s[0], s[1]) - riverHalf;
        if (d < best) best = d;
      }
      for (const l of near) {
        const d = lakeDist(p, l);
        if (d < best) best = d;
      }
      return best;
    };
    if (sd(S) <= 0) return null; // the green itself is under water: give up

    // The nearest water of each sort, each judged against its own reach: the
    // river is everywhere and has to be close, a lake is rare and worth a walk.
    // Whichever has more slack is tried first; if nothing can be rooted on that
    // shore, the other one still gets its turn.
    const aims: { at: Pt; max: number; slack: number }[] = [];
    let rd = Infinity;
    let rq: Pt | null = null;
    for (const s of segs) {
      const q = segClosest(S, s[0], s[1]);
      const d = dist(S, q) - riverHalf;
      if (d < rd) {
        rd = d;
        rq = q;
      }
    }
    if (rq && rd <= site.r + JETTY_REACH) {
      aims.push({ at: rq, max: site.r + JETTY_REACH, slack: rd - site.r - JETTY_REACH });
    }
    let ld = Infinity;
    let lq: Pt | null = null;
    for (const l of near) {
      const d = lakeDist(S, l);
      if (d < ld) {
        ld = d;
        lq = [l.u, l.v];
      }
    }
    if (lq && ld <= site.r + JETTY_LAKE_REACH) {
      aims.push({ at: lq, max: site.r + JETTY_LAKE_REACH, slack: ld - site.r - JETTY_LAKE_REACH });
    }
    if (!aims.length) return null;
    aims.sort((a, b) => a.slack - b.slack);

    for (const pick of aims) {
      const found = tryShore(pick.at, pick.max);
      if (found) return found;
    }
    return null;

    /** Walk the shore around `target` looking for somewhere to root a deck. */
    function tryShore(target: Pt, MAXD: number): { root: Pt; dir: number; len: number } | null {
      const aim = Math.atan2(target[1] - S[1], target[0] - S[0]);
      // Straight at the water first, then along the shore either way.
      for (let k = 0; k < 13; k++) {
        const a = aim + Math.ceil(k / 2) * (k % 2 ? 1 : -1) * 0.17;
        const cu = Math.cos(a);
        const cv = Math.sin(a);
        let lo = 0;
        let hi = -1;
        for (let d = 0.2; d <= MAXD + 0.4; d += 0.16) {
          if (sd([S[0] + cu * d, S[1] + cv * d]) < 0) {
            hi = d;
            break;
          }
          lo = d;
        }
        if (hi < 0) continue;
        for (let it = 0; it < 18; it++) {
          const m = (lo + hi) / 2;
          if (sd([S[0] + cu * m, S[1] + cv * m]) > 0) lo = m;
          else hi = m;
        }
        const at = (lo + hi) / 2;
        if (at > MAXD) continue;
        const B: Pt = [S[0] + cu * at, S[1] + cv * at];
  
        // The bank's own normal, pointing inland: the gradient of `sd` at B.
        const e = 0.09;
        let nu = sd([B[0] + e, B[1]]) - sd([B[0] - e, B[1]]);
        let nv = sd([B[0], B[1] + e]) - sd([B[0], B[1] - e]);
        const nl = Math.hypot(nu, nv);
        if (nl < 1e-6) {
          nu = -cu;
          nv = -cv;
        } else {
          nu /= nl;
          nv /= nl;
        }
        const root: Pt = [B[0] + nu * JETTY_ROOT, B[1] + nv * JETTY_ROOT];
  
        // How much water there is to build over: walk on across it until the far
        // side comes up. A lake runs out of patience before it runs out of water;
        // the river gives back its own narrow width, and the deck stops at a
        // fraction of it rather than half-bridging the stream.
        let across = JETTY_LEN * 3;
        for (let d = 0.2; d <= JETTY_LEN * 3; d += 0.14) {
          if (sd([B[0] - nu * d, B[1] - nv * d]) > 0) {
            across = d;
            break;
          }
        }
        const reach = Math.min(JETTY_LEN - JETTY_ROOT, across * 0.44);
        if (reach < 0.7) continue; // shore too shallow to reach past
        const head: Pt = [B[0] - nu * reach, B[1] - nv * reach];
        if (sd(head) > -0.12) continue;
        // Which water did the deck actually reach? `sd` takes the nearest bank
        // of either sort, and a ray aimed at a lake can cross the river on the
        // way there — so the reach is judged against the water the deck ends up
        // over, never against the water it set out for.
        let onLake = false;
        for (const l of near) {
          if (lakeDist(head, l) < 0) {
            onLake = true;
            break;
          }
        }
        if (dist(S, root) > site.r + (onLake ? JETTY_LAKE_REACH : JETTY_REACH)) continue;
        if (offRock(root, PROP_ROCK_CLEAR)) continue;
        let clash = false;
        for (const b of siteBuildings[si]) {
          if (dist(root, [b.gx - b.gy, b.gx + b.gy]) < fpR(b.w) + 0.9) {
            clash = true;
            break;
          }
        }
        if (clash) continue;
        return { root, dir: Math.atan2(-nv, -nu), len: JETTY_ROOT + reach };
      }
      return null;
    }
  };

  const siteProps: PropSpec[][] = sites.map((site, si) => {
    const prng = mulberry32((seed + si * 60013 + 7) >>> 0);
    const props: PropSpec[] = [];
    const placedUV: Pt[] = [];

    // `ok` only ever sees points inside the green (the first test rejects the
    // rest), so the river and every route can be pre-trimmed to the segments
    // that could reach that box. Segments dropped here are strictly further
    // away than the threshold from every candidate, so the tests are exact.
    const reach = site.r * 0.92;
    const bu0 = site.u - reach;
    const bu1 = site.u + reach;
    const bv0 = site.v - reach;
    const bv1 = site.v + reach;
    const nearRiverSegs = segsNearBox(river, bu0, bv0, bu1, bv1, 1.6);
    const nearRoadSegs: Pt[][] = [];
    for (const line of roadLines) {
      for (const s of segsNearBox(line, bu0, bv0, bu1, bv1, 1.3)) nearRoadSegs.push(s);
    }

    const ok = (p: Pt): boolean => {
      if (dist(p, [site.u, site.v]) > reach) return false;
      if (anySegWithin(p, nearRiverSegs, 1.6)) return false;
      if (anySegWithin(p, nearRoadSegs, 1.3)) return false;
      if (offLake(p, PROP_LAKE_CLEAR)) return false;
      if (offRock(p, PROP_ROCK_CLEAR)) return false;
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
        // Dressing may crowd a road; it may not stand in a lake or on a rock.
        if (offLake(p, PROP_LAKE_CLEAR) || offRock(p, PROP_ROCK_CLEAR)) continue;
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

    // Decision rolls first, so the stream shape does not depend on which of
    // the optional pieces this town happens to qualify for.
    const campRoll = prng();
    const flavourBase = 2 + Math.floor(prng() * 4); // 2..5 — the scale-1 figure

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

    // A quarry town's lamps stand on dressed stone posts rather than on iron:
    // same lantern, same height, same hour it is lit. Pure function of the
    // town's quarry-ness, which is read off the full roster, so the kind is the
    // only thing that changes and it changes at every pace or at none.
    const lampKind = siteQuarry[si] ? 'lamp-stone' : 'lamp';
    const lamps = site.r > 6.5 ? 2 : 1;
    for (let i = 0; i < lamps; i++) {
      add(`${site.id}-lamp${i}`, lampKind, spot(0.44, signA + Math.PI * (0.6 + i)), 31 + i + si * 3);
    }

    // A finger post where three or more lanes meet.
    if (roadDegree[si] >= 3) {
      add(`${site.id}-post`, 'signpost', spot(0.4, signA + 2.2), 41 + si);
    }

    // The newest holdings are still half a camp: the last of the day's
    // baseline towns always keeps a fire in the green, and the frontier
    // holdings beyond it usually do. Keyed to nBase, which is drawn from the
    // seed alone, so "newest" never moves when the roster is trimmed.
    if (si >= nBase - 1 && (si === nBase - 1 || campRoll < 0.6)) {
      add(`${site.id}-fire`, 'campfire', spot(0.24, signA + Math.PI * 1.35), 51 + si);
    }

    // Timber stacked where the axes have been busiest — and a stack more in a
    // logging town, which is the one piece of dressing its trade is worth on
    // its own (founders and professions, additive). Essentials tier, and keyed
    // to the FULL roster, so it is there at every pace or at none.
    const piles = clamp(
      (siteTimber[si] >= 44 ? 2 : siteTimber[si] >= 20 ? 1 : 0) +
        (siteProfession[si] === 'logging' ? 1 : 0),
      0,
      3
    );
    for (let i = 0; i < piles; i++) {
      add(
        `${site.id}-timber${i}`,
        'lumber',
        spot(0.66 + prng() * 0.12, prng() * Math.PI * 2),
        61 + i + si * 5
      );
    }

    // A quarry town keeps its stone yard on the side of the green that faces
    // the rock: dressed blocks waiting to go up, a crane over them, and the
    // rough stone they came out of. Part of the ESSENTIALS block, above the
    // flavour tail, so it is there at every pace or at none.
    const oc = siteQuarry[si];
    if (oc) {
      const yardA = Math.atan2(oc.v - site.v, oc.u - site.u);
      add(`${site.id}-quarry0`, 'quarry-blocks', spot(0.74, yardA), 71 + si * 7);
      add(`${site.id}-crane`, 'crane', spot(0.6, yardA + 0.5), 81 + si * 7);
      add(`${site.id}-quarry1`, 'quarry-blocks', spot(0.66, yardA - 0.62), 91 + si * 7);
      add(`${site.id}-rubble`, 'rock', spot(0.82, yardA + 1.1), 101 + si * 7);
    }

    /* ---- the water, if this town has any ------------------------------- *
     * ADDITIVE BLOCK — boats and jetties. Essentials tier, so it is there at
     * every pace or at none, and the flavour tail below is still the only
     * scale-dependent slice. Its own substream: the dressing stream above is
     * what every existing prop's position comes out of, and a town with a
     * jetty must not shuffle its own well because of it.
     * -------------------------------------------------------------------- */
    const jetty = jettyFor(site, si);
    if (jetty) {
      const jrng = mulberry32((seed + si * 74519 + 1301) >>> 0);
      const side = jrng() < 0.5 ? 1 : -1;
      const hull = (seed + si * 9403 + 17) >>> 0;
      const [jgx, jgy] = uv(jetty.root[0], jetty.root[1]);
      props.push({
        id: `${site.id}-jetty`,
        kind: 'jetty',
        gx: jgx,
        gy: jgy,
        seed: (131 + si * 7) >>> 0,
        dir: jetty.dir,
        len: jetty.len,
      });
      placedUV.push(jetty.root);
      // The boat lies alongside the head of the deck, on the same bearing.
      const cd = Math.cos(jetty.dir);
      const sv = Math.sin(jetty.dir);
      const along = Math.max(0.55, jetty.len - 0.45);
      const moor: Pt = [
        jetty.root[0] + cd * along - sv * 0.72 * side,
        jetty.root[1] + sv * along + cd * 0.72 * side,
      ];
      const [bgx, bgy] = uv(moor[0], moor[1]);
      props.push({
        id: `${site.id}-boat`,
        kind: 'rowboat',
        gx: bgx,
        gy: bgy,
        seed: hull,
        dir: jetty.dir,
      });
      placedUV.push(moor);
    }

    /* ---- flavour tail: the only part the day's pace can shorten -------- */
    // `flavourBase` is what a baseline day sees; a busier town works its way
    // further down the same list, a quieter one stops sooner. Monotonic in the
    // build count, so the prefix property holds across every pair of scales.
    const essentials = props.length;
    const room = Math.max(0, siteBuiltMax[si] - siteBuiltBase[si]);
    const flavourMax = flavourBase + room;
    const flavourAt = (built: number) =>
      clamp(flavourBase + Math.round((built - siteBuiltBase[si]) * 0.75), 1, flavourMax);
    // founders and professions (additive): the SAME single draw, read through
    // the bag this town's trade keeps. Positions are untouched — `spot()` is
    // called with exactly the arguments it was called with before.
    const flavourBag = PROFESSION_FLAVOUR[siteProfession[si]];
    for (let i = 0; i < flavourMax; i++) {
      const kind = flavourBag[Math.floor(prng() * flavourBag.length)];
      add(`${site.id}-p${i}`, kind, spot(0.62 + prng() * 0.22, prng() * Math.PI * 2), 200 + si * 31 + i);
    }
    sitePropCount.push(essentials + flavourAt(siteBuilt[si]));
    return props;
  });

  // Dressing wins over undergrowth: fell any unclaimed tree standing on a prop.
  siteProps.forEach((props) => {
    for (const p of props) {
      const pu = p.gx - p.gy;
      const pv = p.gx + p.gy;
      for (const i of treesNear(pu, pv, 1.1)) {
        const t = trees[i];
        if (protectedTrees.has(t.id) || roadClaimed.has(t.id) || dead.has(t.id)) continue;
        if (dist(treeUV[i], [pu, pv]) < 1.1) dead.add(t.id);
      }
    }
  });

  // Whoever buried a chest cleared a yard of ground to do it, and the wood has
  // not quite taken it back. Same rule as the dressing above: only unclaimed
  // undergrowth gives way, so nobody's felling appointment is cancelled. Chest
  // positions are scale-free, so this leaves the tree list scale-identical.
  for (const chest of chests) {
    const cu = chest.gx - chest.gy;
    const cv = chest.gx + chest.gy;
    for (const i of treesNear(cu, cv, 1.1)) {
      const t = trees[i];
      if (protectedTrees.has(t.id) || roadClaimed.has(t.id) || dead.has(t.id)) continue;
      if (dist(treeUV[i], [cu, cv]) < 1.1) dead.add(t.id);
    }
  }

  /* ---- ruins (additive) -------------------------------------------------- */
  // The wood grows up to a wall and not through it. Same rule as the chests
  // above: only unclaimed undergrowth gives way, so nobody's felling
  // appointment is cancelled — and ruin positions are scale-free, so the tree
  // list stays byte-identical at every pace.
  for (const ruin of ruins) {
    const ru = ruin.gx - ruin.gy;
    const rv = ruin.gx + ruin.gy;
    const clearR = fpR(ruin.w) + 0.5;
    for (const i of treesNear(ru, rv, clearR)) {
      const t = trees[i];
      if (protectedTrees.has(t.id) || roadClaimed.has(t.id) || dead.has(t.id)) continue;
      if (dist(treeUV[i], [ru, rv]) < clearR) dead.add(t.id);
    }
  }
  /* ---- end ruins (additive) ---------------------------------------------- */

  /* ---- standing stones (additive) ---------------------------------------- */
  // A monument clears its own ground, and has done for a very long time: the
  // ring is heather and nothing else. Same rule as the ruins above — only
  // unclaimed undergrowth gives way, so nobody's felling appointment is
  // cancelled — and the ring's position is scale-free, so the tree list stays
  // byte-identical at every pace.
  for (const st of stones) {
    const su = st.gx - st.gy;
    const sv = st.gx + st.gy;
    const clearR = fpR(st.w) + 0.7;
    for (const i of treesNear(su, sv, clearR)) {
      const t = trees[i];
      if (protectedTrees.has(t.id) || roadClaimed.has(t.id) || dead.has(t.id)) continue;
      if (dist(treeUV[i], [su, sv]) < clearR) dead.add(t.id);
    }
  }
  /* ---- end standing stones (additive) ------------------------------------ */

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
      // Append-only: the flavour tail is the sanctioned scale-dependent slice.
      // Undergrowth was already cleared against the FULL list above, so the
      // trees do not move when the tail is short.
      props: siteProps[i].slice(0, sitePropCount[i]),
      /* ---- founders and professions (additive) -------------------------- */
      // Both read off the FULL roster at index i, so the trim above cannot
      // rename a town or change its trade — only leave it out of the day.
      founder: founders[i],
      profession: siteProfession[i],
      /* ---- end founders and professions (additive) ---------------------- */
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
    lakes: lakes.map((l) => {
      const [gx, gy] = uv(l.u, l.v);
      return {
        id: l.id,
        gx,
        gy,
        rx: l.rx,
        ry: l.ry,
        rot: l.rot,
        seed: l.seed,
        fed: l.fed,
        pts: lakeOutline(l, 1).map((p) => uv(p[0], p[1]) as Vec2),
      };
    }),
    outcrops: outcrops.map((o) => {
      const [gx, gy] = uv(o.u, o.v);
      return { id: o.id, gx, gy, radius: o.radius, seed: o.seed };
    }),
    sites: siteSpecs,
    roads: activeRoads,
    bridges: activeBridges,
    fords: activeFords,
    trees: liveTrees,
    scatter,
    chests,
    /* ---- ruins (additive) ---- */
    ruins,
    /* ---- end ruins (additive) ---- */
    /* ---- standing stones (additive) ---- */
    stones,
    /* ---- end standing stones (additive) ---- */
    valleyName: valley,
  };
}
