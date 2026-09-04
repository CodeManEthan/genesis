/**
 * Genesis — the player.
 *
 * The founder is a person standing in the valley rather than a camera looking
 * at it. This module is the whole of what that costs the engine: where the
 * avatar is, what ground it may stand on, and what the ledger would say about
 * the ground it is standing on.
 *
 * HARD RULES, the same ones gen.ts and timeline.ts keep: no DOM, no
 * `Date.now()`, no `Math.random()`. Nothing here is ever consulted by a
 * seed-only world — `TheGenesis` only builds an avatar when the play route
 * asks for one — so a homepage frame is byte-identical with this file present
 * or absent.
 *
 * DETERMINISM. Movement runs on a FIXED tick, never on the frame's `dt`. Given
 * the same held-key state per tick from the same start, the avatar lands on the
 * same tile to the last bit, on a 144Hz laptop and on a throttled headless
 * Chrome alike. That is the property a future input log needs: the log records
 * key state against a tick number, and replaying it reproduces the walk. The
 * log itself is NOT built here — this module has no memory beyond the current
 * state, and the island holds that.
 */

import {
  TW,
  isoX,
  isoY,
  type BuildingSpec,
  type GenesisMap,
  type SiteSpec,
  type Vec2,
  type WorldSnapshot,
} from './types.ts';

/* -------------------------------- constants ------------------------------ */

/** Simulation ticks a second. The renderer's frame rate is nobody's business. */
export const TICK_HZ = 60;
/** Seconds a tick. Movement is only ever integrated by this. */
export const TICK_DT = 1 / TICK_HZ;

/**
 * Tiles a second on open ground. `scene.ts` walks its villagers at WALK_SPEED
 * = 1.05, and the founder is one of them, not a vehicle — the whole point of
 * the avatar reading as a person of the valley is that it moves like one.
 */
export const AVATAR_SPEED = 1.05;
/** On a built road. A made-up surface is the reason to build one. */
export const AVATAR_ROAD_SPEED = 1.85;

/** Never integrate more than this many ticks in one frame: a backgrounded tab
 * comes back with a second of arrears, and the valley should not lurch. */
export const MAX_CATCHUP = 5;

/* --------------------------------- geometry ------------------------------ */

type Pt = readonly [number, number];

function segDist(px: number, py: number, a: Pt, b: Pt): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy || 1;
  let t = ((px - a[0]) * vx + (py - a[1]) * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (a[0] + vx * t);
  const dy = py - (a[1] + vy * t);
  return Math.hypot(dx, dy);
}

/** Distance from a point to a polyline, tile space. */
function polyDist(px: number, py: number, pts: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = segDist(px, py, pts[i], pts[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

/** Even-odd point-in-polygon, tile space. A lake outline is closed. */
function inPoly(px: number, py: number, pts: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-9) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Cumulative arclength down a road, memoised per map.
 *
 * The snapshot stores a road as a *fraction* of its length that has been made,
 * so "am I on made road?" needs the fraction of the nearest point, not just
 * its distance. A WeakMap keyed on the map keeps that off the hot path without
 * outliving the valley it describes.
 */
const roadArc = new WeakMap<GenesisMap, Map<string, number[]>>();

function arcOf(map: GenesisMap, id: string, pts: Vec2[]): number[] {
  let per = roadArc.get(map);
  if (!per) {
    per = new Map();
    roadArc.set(map, per);
  }
  let cum = per.get(id);
  if (!cum) {
    cum = [0];
    for (let i = 0; i + 1 < pts.length; i++) {
      cum.push(cum[i] + Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
    }
    per.set(id, cum);
  }
  return cum;
}

/* --------------------------------- terrain ------------------------------- */

/** What the ground under a tile is, as far as a walker cares. */
export interface Footing {
  /** May the founder stand here at all? */
  walkable: boolean;
  /** Tiles a second here. */
  speed: number;
  /** The road being walked, if any. */
  roadId?: string;
  roadKind?: 'highway' | 'lane' | 'track';
  /** The crossing being stood on, if any. */
  bridgeId?: string;
  fordId?: string;
}

/**
 * Half-extent, in SCREEN-ALIGNED u/v, of the block a building of art width `w`
 * puts down, plus a little for the eaves.
 *
 * A building's base is a diamond in tile space and a square in u/v — screen x
 * is u·TW/2, so a sprite `w` art pixels wide reaches w/TW either side of its
 * anchor in u, and the same again in v because the footprint is square. Test
 * that box in TILE space instead and you get the same square rotated 45°,
 * which is how the founder came to be wedged in a town square with three of
 * the four ways out closed by houses that were nowhere near them.
 */
const buildingHalf = (w: number) => w / TW + 0.25;

/** A building is only in the way once somebody has raised a wall on it. */
function blocking(map: GenesisMap, snap: WorldSnapshot): BuildingSpec[] {
  const out: BuildingSpec[] = [];
  for (const site of map.sites) {
    for (const b of site.buildings) {
      const st = snap.buildings.get(b.id);
      if (!st) continue;
      if (st.status === 'building' || st.status === 'done') out.push(b);
    }
  }
  return out;
}

/**
 * The founder's footing at a tile.
 *
 * Water stops you — the river at its own half-width, and any lake inside its
 * outline. A decked bridge and a ford do not: they are exactly the places the
 * valley built so the water would stop mattering, and one of them is the only
 * way to the far bank on foot. A bridge still being piled (stage 1) is a row
 * of posts standing in the current and holds nobody up.
 */
export function footingAt(map: GenesisMap, snap: WorldSnapshot, gx: number, gy: number): Footing {
  /* ---- a crossing beats everything, including the water under it ------- */
  for (const br of map.bridges) {
    if ((snap.bridges.get(br.id) ?? 0) < 2) continue;
    if (Math.hypot(gx - br.gx, gy - br.gy) < br.span * 0.5 + 0.6) {
      return { walkable: true, speed: AVATAR_ROAD_SPEED, bridgeId: br.id, roadId: br.roadId };
    }
  }
  for (const fd of map.fords ?? []) {
    if (Math.hypot(gx - fd.gx, gy - fd.gy) < fd.span * 0.5 + 0.6) {
      // Knee-deep and stony: passable, and not quick.
      return { walkable: true, speed: AVATAR_SPEED * 0.7, fordId: fd.id, roadId: fd.roadId };
    }
  }

  /* ---- water ----------------------------------------------------------- */
  if (polyDist(gx, gy, map.river) < map.riverWidth + 0.15) return { walkable: false, speed: 0 };
  for (const lk of map.lakes) {
    if (inPoly(gx, gy, lk.pts)) return { walkable: false, speed: 0 };
  }

  /* ---- walls ----------------------------------------------------------- */
  const u = gx - gy;
  const v = gx + gy;
  for (const b of blocking(map, snap)) {
    const r = buildingHalf(b.w);
    if (Math.abs(u - (b.gx - b.gy)) < r && Math.abs(v - (b.gx + b.gy)) < r) {
      return { walkable: false, speed: 0 };
    }
  }

  /* ---- made road ------------------------------------------------------- */
  for (const road of map.roads) {
    const built = snap.roads.get(road.id) ?? 0;
    if (built <= 0) continue;
    const cum = arcOf(map, road.id, road.pts);
    const total = cum[cum.length - 1] || 1;
    let best = Infinity;
    let bestArc = 0;
    for (let i = 0; i + 1 < road.pts.length; i++) {
      const d = segDist(gx, gy, road.pts[i], road.pts[i + 1]);
      if (d < best) {
        best = d;
        bestArc = cum[i];
      }
    }
    if (best < road.width + 0.35 && bestArc / total <= built) {
      return { walkable: true, speed: AVATAR_ROAD_SPEED, roadId: road.id, roadKind: road.kind };
    }
  }

  return { walkable: true, speed: AVATAR_SPEED };
}

/* --------------------------------- the walk ------------------------------ */

/** Which of the eight ways is being held, this tick. */
export interface AvatarInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export const NO_INPUT: AvatarInput = { up: false, down: false, left: false, right: false };

export interface AvatarState {
  /** Tile space, the same coordinates every villager stands in. */
  gx: number;
  gy: number;
  /** Which way the sprite is turned. Kept through a stop, like a person. */
  faceRight: boolean;
  /** Walk-cycle phase in seconds. Advanced only while actually moving, so a
   * standing founder stands still rather than marching on the spot. */
  phase: number;
  moving: boolean;
  /** Ticks since the avatar was made — the index a future input log keys on. */
  tick: number;
  /** Last heading in screen-aligned u/v, for the camera's lead. */
  lu: number;
  lv: number;
  /** Whatever footing the last tick found, for the presence line and the HUD. */
  footing: Footing;
}

/**
 * Where a founder starts: on the doorstep of the first house, a tile and a half
 * down-valley of it so the avatar is not standing inside the wall it came out
 * of. If the doorstep turns out to be under something, walk out until it isn't.
 */
export function createAvatar(map: GenesisMap, snap: WorldSnapshot): AvatarState {
  const s0 = map.sites[0];
  let gx = s0.gx + 2.2;
  let gy = s0.gy + 2.2;
  for (let k = 0; k < 12 && !footingAt(map, snap, gx, gy).walkable; k++) {
    gx += 0.8;
    gy += 0.8;
  }
  return {
    gx,
    gy,
    faceRight: true,
    phase: 0,
    moving: false,
    tick: 0,
    lu: 0,
    lv: 1,
    footing: footingAt(map, snap, gx, gy),
  };
}

/**
 * One fixed simulation tick.
 *
 * Movement is authored in SCREEN-ALIGNED u/v — "up" is up the screen, which is
 * what a hand on WASD means — and converted to tiles, because tiles are the
 * space speed is quoted in. A unit step in u/v is 1/√2 of a tile, so the
 * conversion is the one √2 below and nothing else.
 *
 * Collision is resolved per axis: a founder walking into the corner of a
 * smithy slides along its wall instead of sticking to it, which is the whole
 * difference between a world you can move in and one that argues with you.
 */
export function stepAvatar(
  map: GenesisMap,
  snap: WorldSnapshot,
  av: AvatarState,
  input: AvatarInput
): void {
  av.tick++;
  let u = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let v = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  if (u === 0 && v === 0) {
    av.moving = false;
    av.footing = footingAt(map, snap, av.gx, av.gy);
    return;
  }
  const len = Math.hypot(u, v);
  u /= len;
  v /= len;
  av.lu = u;
  av.lv = v;
  if (u > 0.2) av.faceRight = true;
  else if (u < -0.2) av.faceRight = false;

  const foot = footingAt(map, snap, av.gx, av.gy);
  // A unit of u/v is 1/√2 tiles, so a speed quoted in tiles buys √2 of it.
  const step = foot.speed * TICK_DT * Math.SQRT2;
  // u/v -> tiles: gx = (v + u) / 2, gy = (v - u) / 2.
  const dxU = (u * step) / 2;
  const dyU = (-u * step) / 2;
  const dxV = (v * step) / 2;
  const dyV = (v * step) / 2;

  if (u !== 0 && footingAt(map, snap, av.gx + dxU, av.gy + dyU).walkable) {
    av.gx += dxU;
    av.gy += dyU;
  }
  if (v !== 0 && footingAt(map, snap, av.gx + dxV, av.gy + dyV).walkable) {
    av.gx += dxV;
    av.gy += dyV;
  }

  av.moving = true;
  av.phase += TICK_DT;
  av.footing = footingAt(map, snap, av.gx, av.gy);
}

/** Where the founder is on screen, in world pixels. */
export const avatarX = (av: AvatarState) => isoX(av.gx, av.gy);
export const avatarY = (av: AvatarState) => isoY(av.gx, av.gy);

/* -------------------------------- presence ------------------------------- */

/**
 * The ledger noticing you.
 *
 * Every clause below is read off the map and the snapshot — a town's name, the
 * label of the plot the crew is actually on and how much of it is standing,
 * the settlers counted at that town, the state of a chest, the material of a
 * bridge. Nothing is invented, because a line the world cannot back up is
 * worse than no line: the whole voice of the ledger rests on it only ever
 * reporting.
 *
 * `key` is stable while the same fact holds, so the island can fade a line in
 * once rather than on every frame.
 */
export interface Presence {
  key: string;
  text: string;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

export function presenceAt(
  map: GenesisMap,
  snap: WorldSnapshot,
  av: AvatarState
): Presence | null {
  const { gx, gy } = av;

  /* ---- something coming out of the ground ------------------------------- */
  for (const chest of map.chests ?? []) {
    if (Math.hypot(gx - chest.gx, gy - chest.gy) > 3.2) continue;
    const st = snap.chests.get(chest.id);
    if (!st) continue;
    if (st === 'digging') {
      return {
        key: `chest-dig-${chest.id}`,
        text: 'Two of them are down on their knees here with a bar. Nobody is talking.',
      };
    }
    return {
      key: `chest-open-${chest.id}`,
      text: 'The chest is open at your feet, and a good deal lighter than it was this morning.',
    };
  }

  /* ---- a crossing ------------------------------------------------------- */
  if (av.footing.bridgeId) {
    const br = map.bridges.find((b) => b.id === av.footing.bridgeId);
    return {
      key: `bridge-${av.footing.bridgeId}`,
      text:
        br?.material === 'stone'
          ? 'You are on the arch. The river goes under it and has nothing to say about it.'
          : 'Planks under your boots, and a good drop to the water.',
    };
  }
  if (av.footing.fordId) {
    return {
      key: `ford-${av.footing.fordId}`,
      text: 'You are in the ford. Flat stones, knee-deep, and the track picks up on the far bank.',
    };
  }

  /* ---- a town ----------------------------------------------------------- */
  let near: { site: SiteSpec; d: number } | null = null;
  for (const site of map.sites) {
    if (!snap.founded.has(site.id)) continue;
    const d = Math.hypot(gx - site.gx, gy - site.gy);
    if (d > site.radius + 2.5) continue;
    if (!near || d < near.d) near = { site, d };
  }
  if (near) {
    const site = near.site;
    const pop = snap.population.get(site.id) ?? 0;
    let done = 0;
    let surveyed = 0;
    const onIt: { label: string; progress: number }[] = [];
    for (const b of site.buildings) {
      const st = snap.buildings.get(b.id);
      if (!st) continue;
      if (st.status === 'done') done++;
      else if (st.status === 'building') onIt.push({ label: b.label, progress: st.progress });
      else if (st.status === 'surveyed') surveyed++;
    }
    if (onIt.length) {
      onIt.sort((a, b) => b.progress - a.progress);
      const lead = onIt[0];
      const rest =
        onIt.length > 1
          ? `, and ${onIt.length - 1} more plot${onIt.length > 2 ? 's' : ''} going up`
          : '';
      return {
        key: `site-build-${site.id}-${lead.label}`,
        text: `You stand in the ${site.name} yard; the crew are on ${lead.label}, ${pct(lead.progress)} of it standing${rest}.`,
      };
    }
    if (surveyed) {
      return {
        key: `site-survey-${site.id}-${surveyed}`,
        text: `Stakes and string at ${site.name}: ${surveyed} plot${surveyed > 1 ? 's' : ''} marked out, and nobody on them yet.`,
      };
    }
    const who = site.founder ? `${site.founder}'s ${site.name}` : site.name;
    return {
      key: `site-done-${site.id}-${done}-${pop}`,
      text: `${who}, all round you: ${done} roof${done === 1 ? '' : 's'}, ${pop} settler${pop === 1 ? '' : 's'}, and the tools stacked.`,
    };
  }

  /* ---- a road ----------------------------------------------------------- */
  if (av.footing.roadId && av.footing.roadKind) {
    const road = map.roads.find((r) => r.id === av.footing.roadId);
    const to = road ? map.sites.find((s) => s.id === road.to) : undefined;
    return {
      key: `road-${av.footing.roadId}`,
      text: to
        ? `The ${av.footing.roadKind} under your boots is going to ${to.name}. So, for now, are you.`
        : `A made ${av.footing.roadKind}, and somebody swung an axe for every yard of it.`,
    };
  }

  return null;
}
