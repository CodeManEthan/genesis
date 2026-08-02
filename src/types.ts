/**
 * Genesis — shared contract.
 *
 * A world that is born at midnight and lives for one day:
 *
 *   map      = generateMap(seed)          — gen.ts      (pure, DOM-free)
 *   timeline = buildTimeline(map)         — timeline.ts (pure, DOM-free)
 *   render     (map, timeline, t)         — scene.ts + TheGenesis.tsx
 *
 * `t` is the world clock in HOURS, 0 .. 24. The site pins t to the visitor's
 * wall clock by default; the player UI can pause, speed up, or scrub it.
 *
 * HARD RULES for gen.ts and timeline.ts:
 *  - No DOM, no Date.now(), no Math.random(). All randomness through
 *    mulberry32 seeded from the world seed. Same seed => byte-identical output.
 *  - Both must be importable in Node 22 (type stripping) for the test scripts
 *    in scripts/, and in the browser bundle.
 *
 * Coordinates are tile-space (gx, gy), same isometric projection as the vale:
 *   screen x = (gx - gy) * TW/2 ; screen y = (gx + gy) * TH/2
 * Authoring in screen-aligned coords uses u = gx - gy, v = gx + gy.
 */

/* ------------------------------ shared utils ----------------------------- */

export const TW = 32; // tile width in art px
export const TH = 16; // tile height in art px

export const isoX = (gx: number, gy: number) => ((gx - gy) * TW) / 2;
export const isoY = (gx: number, gy: number) => ((gx + gy) * TH) / 2;
/** screen-aligned (u,v) -> tile (gx,gy) */
export const uv = (u: number, v: number): Vec2 => [(v + u) / 2, (v - u) / 2];
export const toU = (gx: number, gy: number) => gx - gy;
export const toV = (gx: number, gy: number) => gx + gy;

/** The canonical PRNG (identical to worldstate.ts / art.ts — float-accumulate
 * variant, NOT the tick-world.mjs variant). */
export function mulberry32(a: number): () => number {
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string -> uint32. Used to turn a UTC date ("2026-08-02")
 * into the day's world seed. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type Vec2 = [number, number]; // [gx, gy]

export interface Rect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/* --------------------------------- map ----------------------------------- */

export type Biome = 'meadow' | 'forest' | 'farm' | 'wetland';

export interface Chunk {
  id: string; // "c3_4"
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  biome: Biome;
  seed: number;
}

export type TreeKind = 'oak' | 'pine' | 'blossom' | 'hedgerow';

export interface TreeSpec {
  id: string; // "tr412"
  kind: TreeKind;
  gx: number;
  gy: number;
  seed: number;
}

/** Non-tree scenery. Kinds must be ones the vale's art.ts can draw:
 * bush | rock | flowers | reeds | stump | crop | haystack | fenceL | fenceR |
 * shed | cart | crates | lumber | barrels | well | lamp | signpost |
 * nameboard | stake | campfire | sheep | crane
 */
export interface PropSpec {
  id: string; // "pr88" (site dressing gets site prefix, e.g. "s2-well")
  kind: string;
  gx: number;
  gy: number;
  seed: number;
}

export type StructureRole =
  | 'cottage'
  | 'house'
  | 'hall'
  | 'barn'
  | 'workshop'
  | 'store'
  | 'chapel'
  | 'tower'
  | 'mill'
  | 'granary'
  | 'smithy'
  | 'shed'
  | 'homestead';

export type RoofStyle = 'hip' | 'gable' | 'flat' | 'thatch';

export interface BuildingSpec {
  id: string; // "s0-b0"
  siteId: string;
  gx: number;
  gy: number;
  role: StructureRole;
  label: string; // "The Smithy", "Row House" …
  w: number; // footprint width in art px, MULTIPLE OF 4, 24..52 (landmark up to 64)
  floors: 1 | 2 | 3;
  roof: RoofStyle;
  chimney: boolean;
  awning: boolean;
  banner: boolean;
  cupola: boolean;
  accent: string; // site accent hex
  seed: number;
  /** Tree ids standing on/near this plot that must be felled before the plot
   * can be surveyed. Empty for the founding house (sites[0].buildings[0]). */
  clears: string[];
}

export interface SiteSpec {
  id: string; // "s0", "s1" … in founding order; s0 = the first homestead
  name: string; // randomly generated town name
  gx: number;
  gy: number;
  radius: number; // tiles, ~4..9
  accent: string; // hex
  /** Build order = array order. buildings[0] of sites[0] pre-exists at t=0. */
  buildings: BuildingSpec[];
  /** Dressing that appears as the site matures (well, lamps, crops, carts…).
   * Array order = appearance order. */
  props: PropSpec[];
}

export interface RoadSpec {
  id: string; // "r0"
  kind: 'highway' | 'lane' | 'track';
  pts: Vec2[]; // polyline, control points every ~2-3 tiles
  width: number; // 0.62 highway / 0.5 lane / 0.4 track
  from: string; // site id
  to: string; // site id
  /** Trees standing on/beside the planned route, in ascending `frac`
   * (0..1 of arclength). The timeline fells each one just before road
   * construction reaches its frac — crews cut their way through the wood.
   * Optional for fixture compatibility; absent means none. */
  clears?: { tree: string; frac: number }[];
}

export interface BridgeSpec {
  id: string; // "br0"
  roadId: string;
  gx: number;
  gy: number;
  span: number; // tiles, ~3.5..5
}

export interface GenesisMap {
  version: 1;
  seed: number;
  bounds: Rect; // full canvas extent (screen-aligned u/v)
  content: Rect; // the "fit" framing rect
  chunks: Chunk[];
  river: Vec2[]; // polyline
  riverWidth: number; // ~0.95
  /** sites[0] sits near the map centre and is where the day begins. */
  sites: SiteSpec[];
  /** The FULL planned road network. Roads are revealed over the day by the
   * timeline; at t=0 none of them exist visually. */
  roads: RoadSpec[];
  bridges: BridgeSpec[];
  /** The wild forest at t=0. Timeline events fell some of these. */
  trees: TreeSpec[];
  /** Wild non-tree scenery, present from t=0. */
  scatter: PropSpec[];
  valleyName: string;
}

/* ------------------------------- timeline -------------------------------- */

/** All event `t` values are hours, 0 <= t < 24, and the events array is
 * sorted ascending by t. Every id referenced must exist in the map. */
export type GenesisEvent =
  | { t: number; type: 'found'; siteId: string; text: string }
  | { t: number; type: 'arrive'; siteId: string; n: number } // settlers join
  | { t: number; type: 'chop-start'; treeId: string } // axe work begins
  | { t: number; type: 'chop-done'; treeId: string } // tree -> stump
  | { t: number; type: 'survey'; buildingId: string } // plot staked out (progress 0.05)
  | { t: number; type: 'build'; buildingId: string; progress: number } // monotonic per building, 1 = done
  | { t: number; type: 'road'; roadId: string; frac: number } // built up to frac of arclength, monotonic
  | { t: number; type: 'bridge'; bridgeId: string; stage: 0 | 1 | 2 | 3 } // 1 pilings, 2 deck, 3 rails/done
  | { t: number; type: 'prop'; propId: string; siteId: string } // dressing appears
  | { t: number; type: 'log'; text: string; siteId?: string }; // ledger line (also emitted alongside milestones)

export interface Timeline {
  events: GenesisEvent[];
}

/* ----------------------------- derived state ----------------------------- */

export type TreeState = 'standing' | 'felling' | 'stump';
export type BuildingStatus = 'unplanned' | 'surveyed' | 'building' | 'done';

export interface WorldSnapshot {
  t: number;
  /** every tree id -> state (missing = standing) */
  trees: Map<string, TreeState>;
  buildings: Map<string, { status: BuildingStatus; progress: number }>;
  roads: Map<string, number>; // id -> built frac (missing = 0)
  bridges: Map<string, 0 | 1 | 2 | 3>;
  props: Set<string>; // site-dressing prop ids that exist
  founded: Set<string>; // site ids
  population: Map<string, number>; // site id -> settlers
  log: { t: number; text: string }[]; // all log-worthy lines up to t
}

/*
 * timeline.ts must export:
 *   buildTimeline(map: GenesisMap): Timeline
 *   emptySnapshot(map: GenesisMap): WorldSnapshot       // state at t=0 (founding house done, 2 settlers)
 *   snapshotAt(map: GenesisMap, tl: Timeline, t: number): WorldSnapshot  // full recompute (for scrub-back)
 *   advance(snap: WorldSnapshot, tl: Timeline, toT: number): void        // forward-only incremental
 *
 * gen.ts must export:
 *   generateMap(seed: number): GenesisMap
 * names.ts must export:
 *   townName(rng: () => number): string
 *   valleyName(rng: () => number): string
 */
