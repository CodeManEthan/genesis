/**
 * Genesis — yesterday's ghost.
 *
 * One extra ruin, standing in today's valley, whose shape is the shape of
 * YESTERDAY'S first landmark.
 *
 * ── WHY THIS IS NOT IN gen.ts ─────────────────────────────────────────────
 * `generateMap` is `f(seed, scale)` and has to stay that way: the whole pace
 * control, the whole harness and the whole subset-stability argument rest on a
 * map being a pure function of one seed. A ruin that quotes the *previous*
 * day's valley is a function of two seeds, so it lives out here instead, and
 * the map never learns about it. Nothing in gen.ts or timeline.ts imports this
 * file; the scene bakes what it is handed, and only TheGenesis — the one place
 * that knows a seed came out of a calendar — knows which seed came before.
 *
 * It is still pure and DOM-free: `ghostFor(map, prevSeed)` is deterministic in
 * exactly those two arguments.
 *
 * ── ON SCALE ──────────────────────────────────────────────────────────────
 * Ordinary ruins are terrain and are byte-identical at every pace. The ghost is
 * NOT: it has to stand clear of the roads and towns of the day it is visiting,
 * and how many of those there are is precisely what the pace control decides.
 * A busier valley may push it to its second or third choice of spot. That is
 * the right behaviour — the alternative is a wall standing in the high street —
 * and it is why the ghost is not in `GenesisMap` and not in the terrain half of
 * the harness's subset checks.
 */

import { generateMap, uvDist, uvPolyDist } from './gen.ts';
import {
  mulberry32,
  uv,
  type Biome,
  type GenesisMap,
  type RuinKind,
  type RuinSpec,
} from './types.ts';

type Pt = [number, number];

/** Tile space -> screen-aligned u/v, the space every distance below is in. */
const toUV = (gx: number, gy: number): Pt => [gx - gy, gx + gy];

/** Even-odd ray cast. `poly` is a closed ring; the last point is not repeated. */
function inside(p: Pt, poly: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1]) {
      const x = a[0] + ((p[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
      if (p[0] < x) hit = !hit;
    }
  }
  return hit;
}

/* ------------------------------- clearances ------------------------------- */
// Deliberately a shade more generous than an ordinary ruin's: the ghost is the
// one piece of the valley a visitor is meant to walk over and find, so it must
// not end up half behind a hedge or two tiles off somebody's front door.
const GHOST_ROAD_CLEAR = 3;
const GHOST_RIVER_CLEAR = 3;
const GHOST_SITE_CLEAR = 4.5;
const GHOST_LAKE_CLEAR = 2;
const GHOST_ROCK_CLEAR = 1.6;
const GHOST_CHEST_CLEAR = 7;
const GHOST_RUIN_CLEAR = 18;

/** Which of yesterday's landmarks casts a tower rather than a wall corner. */
const TOWER_ROLES = new Set(['tower', 'chapel', 'mill', 'granary', 'brewhouse']);

/**
 * The ruin today's valley inherited from yesterday's, or null if yesterday had
 * no landmark to inherit (a fixture map, or a valley of one town) or today has
 * nowhere quiet enough to put it.
 *
 * @param map       today's world, at whatever pace it was generated for
 * @param prevSeed  the seed of the day before this one
 */
export function ghostFor(map: GenesisMap, prevSeed: number): RuinSpec | null {
  /* ---- what it was ----------------------------------------------------- */
  // Always at scale 1, and always through the LRU-cached entry point: the
  // shape of yesterday's landmark is a property of yesterday's seed, not of how
  // hard anybody happens to be working today.
  const prev = generateMap(prevSeed >>> 0, 1);
  // sites[1] is the first town founded after the homestead, and for every site
  // but s0 the landmark is buildings[0] (see gen.ts's building roster).
  const landmark = prev.sites[1]?.buildings[0];
  if (!landmark) return null;

  const kind: RuinKind = TOWER_ROLES.has(landmark.role) ? 'tower' : 'corner';

  /* ---- where it stands, in today's valley ------------------------------ */
  const rng = mulberry32(((prevSeed >>> 0) ^ (map.seed >>> 0) ^ 0x67484f53) >>> 0); // 'gHOS'

  const river = map.river.map((p) => toUV(p[0], p[1]));
  const roads = map.roads.map((r) => r.pts.map((p) => toUV(p[0], p[1])));
  const lakes = (map.lakes ?? []).map((l) => l.pts.map((p) => toUV(p[0], p[1])));
  const chunks = map.chunks;
  const biomeAt = (p: Pt): Biome => {
    for (const c of chunks) {
      if (p[0] >= c.u0 && p[0] < c.u1 && p[1] >= c.v0 && p[1] < c.v1) return c.biome;
    }
    return 'meadow';
  };

  /**
   * A coarse index of the standing wood, because the ghost has to find its own
   * clearing. An ordinary ruin gets one for free — gen.ts fells whatever is
   * standing on it — but the ghost is not map data and cannot touch the tree
   * list, so instead of clearing a glade it goes and stands in one. Which is
   * also the better story: the wood grew back everywhere except here.
   */
  const CELL = 4;
  const treeGrid = new Map<number, Pt[]>();
  for (const tr of map.trees) {
    const q = toUV(tr.gx, tr.gy);
    const k = Math.floor(q[0] / CELL) * 4096 + Math.floor(q[1] / CELL);
    const arr = treeGrid.get(k);
    if (arr) arr.push(q);
    else treeGrid.set(k, [q]);
  }
  /** How many trunks stand within `r` of a point. */
  const treesWithin = (p: Pt, r: number): number => {
    let n = 0;
    const c0 = Math.floor((p[0] - r) / CELL);
    const c1 = Math.floor((p[0] + r) / CELL);
    const d0 = Math.floor((p[1] - r) / CELL);
    const d1 = Math.floor((p[1] + r) / CELL);
    for (let c = c0; c <= c1; c++) {
      for (let d = d0; d <= d1; d++) {
        const arr = treeGrid.get(c * 4096 + d);
        if (!arr) continue;
        for (const q of arr) if (uvDist(p, q) < r) n++;
      }
    }
    return n;
  };

  /** Circumradius of the footprint in u/v — the same measure gen.ts uses. */
  const foot = landmark.w / 32;

  const C = map.content;
  let at: Pt | null = null;
  // Three passes: first insist on a proper clearing, then on standing room,
  // then on anywhere at all. A valley thick enough to fail all three has no
  // ghost today, and the scene simply bakes without one.
  for (let pass = 0; pass < 3 && !at; pass++) {
    // A trunk two units away is a canopy standing right in front of the wall —
    // the sprites are three times as tall as they are wide — so "clear" here
    // has to mean properly clear, not merely not-overlapping.
    const bare = pass === 0 ? foot + 3.4 : pass === 1 ? foot + 1.6 : foot + 0.8;
    const airy = pass === 0 ? { r: foot + 6.5, n: 2 } : null;
    for (let t = 0; t < 6000 && !at; t++) {
      const p: Pt = [
        C.u0 + 4 + (C.u1 - C.u0 - 8) * rng(),
        C.v0 + 4 + (C.v1 - C.v0 - 8) * rng(),
      ];
      const biome = biomeAt(p);
      if (biome !== 'forest' && biome !== 'moor' && biome !== 'meadow') continue;
      if (treesWithin(p, bare) > 0) continue;
      if (airy && treesWithin(p, airy.r) > airy.n) continue;
      if (uvPolyDist(p, river) < GHOST_RIVER_CLEAR) continue;
      let clear = true;
      for (const ring of lakes) {
        if (inside(p, ring) || uvPolyDist(p, ring.concat([ring[0]])) < GHOST_LAKE_CLEAR) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      for (const o of map.outcrops ?? []) {
        if (uvDist(p, toUV(o.gx, o.gy)) < o.radius + GHOST_ROCK_CLEAR) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      for (const s of map.sites) {
        if (uvDist(p, toUV(s.gx, s.gy)) < s.radius + GHOST_SITE_CLEAR) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      for (const line of roads) {
        if (uvPolyDist(p, line) < GHOST_ROAD_CLEAR) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      for (const c of map.chests ?? []) {
        if (uvDist(p, toUV(c.gx, c.gy)) < GHOST_CHEST_CLEAR) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      // Two ruins in one clearing reads as a village; a different story.
      for (const r of map.ruins ?? []) {
        if (uvDist(p, toUV(r.gx, r.gy)) < GHOST_RUIN_CLEAR) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      at = p;
    }
  }
  if (!at) return null;

  const [gx, gy] = uv(at[0], at[1]);
  const biome = biomeAt(at);
  const spec: RuinSpec = {
    id: 'ghost',
    gx,
    gy,
    seed: ((prevSeed >>> 0) ^ 0x1e3f77a5) >>> 0,
    kind,
    w: landmark.w,
    floors: landmark.floors,
    biome,
    where: biome === 'moor' ? 'the high moor' : biome === 'meadow' ? 'the open meadow' : 'the wood',
    ghostOf: prevSeed >>> 0,
    role: landmark.role,
  };
  if (landmark.material) spec.material = landmark.material;
  return spec;
}
