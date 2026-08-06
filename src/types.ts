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

export type Biome = 'meadow' | 'forest' | 'farm' | 'wetland' | 'moor';

export interface Chunk {
  id: string; // "c3_4"
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  biome: Biome;
  seed: number;
}

export type TreeKind = 'oak' | 'pine' | 'blossom' | 'hedgerow' | 'birch' | 'willow' | 'fir';

export interface TreeSpec {
  id: string; // "tr412"
  kind: TreeKind;
  gx: number;
  gy: number;
  seed: number;
}

/** Non-tree scenery. Kinds must be ones the vale's art.ts can draw:
 * bush | rock | flowers | reeds | stump | crop | haystack | fenceL | fenceR |
 * drystoneL | drystoneR | shed | cart | crates | lumber | barrels | well |
 * lamp | lamp-stone | signpost | nameboard | stake | campfire | sheep | crane |
 * quarry-blocks | jetty | rowboat
 *
 * `drystoneL/R` and `lamp-stone` are the stone forms of `fenceL/R` and `lamp`.
 * They share their timber twin's footprint and anchor exactly, and which of the
 * pair gets emitted is a pure function of the nearest town's quarry-ness — no
 * randomness is spent on the choice.
 */
export interface PropSpec {
  id: string; // "pr88" (site dressing gets site prefix, e.g. "s2-well")
  kind: string;
  gx: number;
  gy: number;
  seed: number;
  /* -- boats and jetties (additive; absent for every other kind) ---------- */
  /**
   * Heading in SCREEN-ALIGNED u/v radians, for the handful of kinds that have
   * to face something rather than stand square: a `jetty` points out over the
   * water from its landward root, and the `rowboat` moored at its head lies on
   * the same bearing. Absent means "no bearing", which is every other kind.
   *
   * u/v is the renderer's own space (screen x = u * TW/2, screen y = v * TH/2),
   * so the art can use the angle directly without another projection.
   */
  dir?: number;
  /**
   * Deck length in u/v units, root to head — `jetty` only. A pier is as long as
   * its water allows: out over a lake it runs the full JETTY_LEN, across a
   * narrow river it stops well short of the far bank. Absent means JETTY_LEN.
   */
  len?: number;
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
  | 'bakery'
  | 'brewhouse'
  | 'homestead'
  /** Never drawn from the common or landmark bags: a gildhall is only ever
   * built with a charter dug out of a treasure chest. See ChestSpec. */
  | 'gildhall';

export type RoofStyle = 'hip' | 'gable' | 'flat' | 'thatch';

/**
 * What a building is BUILT of. Absent means 'timber' — the original cream
 * render-and-frame walls every town had before quarry towns existed, so an
 * older fixture or a hand-written spec keeps drawing exactly what it drew.
 */
export type BuildMaterial = 'timber' | 'stone';

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
  /** Optional; absent === 'timber'. Every plot in a quarry town is 'stone'. */
  material?: BuildMaterial;
}

/* ==================== founders and professions (additive) ================= */

/**
 * What a town lives on, read off the ground it was founded on.
 *
 *   fishing  its rim comes within a few units of the river or a lake — the
 *            same geography that tends to earn it a jetty.
 *   logging  it was founded in thick wild wood.
 *   farming  there is ploughed ground around it.
 *   plain    none of the above, and the founding homestead s0, which is
 *            everything at once and so is nothing in particular.
 *
 * A profession is a pure function of the FULL town roster and the terrain, so
 * it is the same at 0.25x as at 4x. It is additive in effect: it re-weights
 * bags that were already being rolled against (building roles, dressing
 * flavour) and adds ledger lines. It never changes how many rolls are made.
 */
export type Profession = 'fishing' | 'logging' | 'farming' | 'plain';

/* ================== end founders and professions (additive) ============== */

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
  /* ---- founders and professions (additive) ---------------------------- */
  /** Whoever drove the first stake here. Optional so hand-written fixtures
   * predating founders still typecheck; gen.ts always writes it. */
  founder?: string;
  /** What the town lives on. Optional for the same reason; absent means
   * 'plain', and gen.ts always writes it. */
  profession?: Profession;
  /* ---- end founders and professions (additive) ------------------------ */
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
  /**
   * What the crossing is BUILT of. Absent means 'timber' — the pilings, plank
   * deck and rail every bridge was before quarry towns had anything to say
   * about it, so an older fixture or a hand-written spec draws what it drew.
   *
   * 'stone' is masonry piers, an arch and a slate-coped parapet over exactly
   * the same footprint and span. Like BuildingSpec.material it is a pure
   * function of the FULL roster and the terrain — both towns the road joins
   * quarry, or the crossing itself lands within STONE_BRIDGE_REACH of bare
   * rock — so it costs no randomness and never moves under the pace scale.
   */
  material?: BuildMaterial;
}

/**
 * A ford: where the LIGHTEST road class meets the river, nobody builds
 * anything. The bank is trodden down either side, a line of flat stones goes
 * in, and the track walks through the shallows and out the other side.
 *
 * A ford is the counterpart of a BridgeSpec and is derived by exactly the same
 * pass over road x river crossings — the choice between the two is a pure
 * function of `RoadSpec.kind` and costs no randomness. Every crossing carries
 * one or the other and never both:
 *
 *   highway | lane  ->  BridgeSpec, three build stages, gates the road
 *   track           ->  FordSpec,   no stages at all, gates nothing
 *
 * Because there is nothing to build there is nothing to track: fords never
 * enter the build state the way `WorldSnapshot.bridges` does. The one thing
 * the day records is that the road head walked through, which is a single
 * `ford` event and one line in the ledger.
 */
export interface FordSpec {
  id: string; // "fd0"
  roadId: string;
  gx: number;
  gy: number;
  /** tiles — how wide the shallows are trodden, a shade under a bridge span */
  span: number;
}

/* --------------------------- buried treasure ----------------------------- */

/**
 * What a chest is worth to whoever turns it up.
 *
 *   coin     — a hoard. The finding town raises `grant` EXTRA plots today that
 *              it would otherwise never have got round to.
 *   charter  — a document. The finding town raises one gildhall, a silhouette
 *              no ordinary roster can produce.
 *   trinket  — a comb, a bad coin, forty years of damp. No material reward at
 *              all; the whole of it is a ledger line.
 */
export type ChestReward = 'coin' | 'charter' | 'trinket';

/**
 * A chest buried in the deep wood or out on the moor, well off any road.
 *
 * CHESTS ARE TERRAIN. Position, reward, finder and luck are a pure function of
 * the seed and are byte-identical at every pace scale — see the SCALE RULE in
 * gen.ts. What the pace scale *can* do is trim the finding town, or the plots
 * the chest paid for, out of the day; when that happens the timeline narrates
 * the find at trinket tier and nothing material changes hands.
 */
export interface ChestSpec {
  id: string; // "ch0"
  gx: number;
  gy: number;
  seed: number;
  /** The ground it is buried in — only ever 'forest' or 'moor'. */
  biome: Biome;
  /** Ledger-ready name for the place: "the fir wood", "the high moor". */
  where: string;
  reward: ChestReward;
  /** Roster index of the town that finds it. Never 0 — the founding house has
   * enough to be getting on with. */
  siteIndex: number;
  /** `s${siteIndex}`. The town may not exist at a small pace scale. */
  siteId: string;
  /** Does the day's digging turn it up at all? False on a tease day. */
  found: boolean;
  /** Buildings this chest paid for, in the finding town's FULL roster. Empty
   * for trinket tier and for every unfound chest. A smaller pace scale may
   * trim some or all of them away. */
  grantIds: string[];
}

/* --------------------------- standing water ------------------------------ */

/**
 * Standing water. A lake is an ellipse in screen-aligned u/v with a low-order
 * radial wobble on it, so it reads as a blobby pond rather than as a drawn
 * ellipse. Both descriptions are carried:
 *
 *   gx/gy/rx/ry/rot/seed  the analytic shape — cheap containment and margin
 *                         tests, and what the outline was generated from.
 *   pts                   the resolved closed outline in TILE space, which is
 *                         what the renderer fills and what the harness tests
 *                         road crossings against. First point is not repeated.
 *
 * Lakes are TERRAIN: generated before the town roster, from the seed alone, so
 * they are byte-identical at every pace scale.
 */
export interface LakeSpec {
  id: string; // "lk0"
  gx: number; // centre, tile space
  gy: number;
  rx: number; // semi-axis along the lake's own major axis, in u/v units
  ry: number; // semi-axis across it
  rot: number; // rotation of the major axis in u/v space, radians
  seed: number; // the wobble substream seed
  /** True when the river runs into the lake's rim — a fed lake, not a pond. */
  fed: boolean;
  /** Closed outline, tile space, ~28 points. */
  pts: Vec2[];
}

/**
 * A bare rock outcrop: the reason a town builds in stone. The boulders
 * themselves are ordinary `rock` entries in `scatter`; this is the field that
 * says where the stone is, and it is what makes a nearby town a quarry town.
 * Terrain, like lakes — never a function of the pace scale.
 */
export interface OutcropSpec {
  id: string; // "oc0"
  gx: number;
  gy: number;
  radius: number; // u/v units, ~2.4..4.4
  seed: number;
}

/* ============================ ruins (additive) ============================ */

/**
 * What is left of a wall.
 *
 *   corner   two faces of a rectangular building meeting at a quoin, standing
 *            about four courses, everything above them gone.
 *   tower    a round-ish stub — the bottom of something that was taller than
 *            anything else for a long way.
 *   rubble   no wall at all: a footing line under the moss and a spill of
 *            dressed stone somebody has been quietly taking away for years.
 */
export type RuinKind = 'corner' | 'tower' | 'rubble';

/**
 * Overgrown remains, out in the wood or on the moor.
 *
 * RUINS ARE TERRAIN. Every field is a pure function of the seed and is
 * byte-identical at 0.25x and at 4x — they are drawn from a derived substream
 * (`mulberry32(seed ^ salt)`) that never touches gen.ts's main sequence. A day
 * neither builds them nor pulls them down; the only thing the timeline has to
 * say about one is that the new road went past it.
 *
 * THE GHOST is the one exception, and it is deliberately not in `GenesisMap`:
 * see `ghostFor()` in ghost.ts. It is a RuinSpec like any other, but its shape
 * comes from YESTERDAY'S seed, so it cannot be a pure function of this one.
 */
export interface RuinSpec {
  id: string; // "ru0"; the ghost is always "ghost"
  gx: number;
  gy: number;
  seed: number;
  kind: RuinKind;
  /** Footprint width in art px, multiple of 4 — what the thing used to be. */
  w: number;
  /** Storeys it once had. Nothing like that many are still standing. */
  floors: 1 | 2 | 3;
  /** The ground it stands in — 'forest' | 'moor' | 'meadow'. */
  biome: Biome;
  /** Ledger-ready name for the place: "the fir wood", "the high moor". */
  where: string;
  /** The ghost only: the seed whose valley this is the echo of. */
  ghostOf?: number;
  /** The ghost only: the landmark role its silhouette is quoting. */
  role?: StructureRole;
  /** The ghost only: was that landmark built of stone? */
  material?: BuildMaterial;
}

/* ========================== end ruins (additive) ========================== */

/* ======================= standing stones (additive) ======================= */

/**
 * What somebody dragged up onto the moor, and why the town down the hill is
 * called what it is called.
 *
 *   circle   five to seven uprights in a ring, one of them down in the heather.
 *   dolmen   two uprights carrying a capstone: a door with nothing behind it.
 *   row      three or four stones marching, evenly spaced, all one way.
 */
export type StoneKind = 'circle' | 'dolmen' | 'row';

/**
 * A stone monument. TERRAIN, exactly as ruins and chests are: every field is a
 * pure function of the seed and is byte-identical at 0.25x and at 4x, drawn
 * from a derived substream (`mulberry32(seed ^ salt)`) that never touches
 * gen.ts's main sequence.
 *
 * At most one to a valley, and only ever on a moor chunk — so a seed whose day
 * has no open moor in it has no stones either. That is the scarcity that makes
 * them worth walking to.
 */
export interface StoneSpec {
  id: string; // "st0"
  gx: number;
  gy: number;
  seed: number;
  kind: StoneKind;
  /** Uprights: 5..7 for a circle, 2 for a dolmen, 3..4 for a row. */
  count: number;
  /** Index of the one that came down, or -1 where none did. Circles only. */
  fallen: number;
  /** Ring diameter / row length in art px, a multiple of 4 — as `RuinSpec.w`. */
  w: number;
  /** Which way the ring is turned, or the row is marching. Ground radians. */
  rot: number;
  /** The ground it stands on. Always 'moor'. */
  biome: Biome;
  /** Ledger-ready name for the place: "the high moor". */
  where: string;
  /** Roster id of the town that took its name from the stones, if any. */
  townId?: string;
  /** That town's name, as the stones left it. */
  townName?: string;
}

/* ===================== end standing stones (additive) ===================== */

export interface GenesisMap {
  version: 1;
  seed: number;
  bounds: Rect; // full canvas extent (screen-aligned u/v)
  content: Rect; // the "fit" framing rect
  chunks: Chunk[];
  river: Vec2[]; // polyline
  riverWidth: number; // ~0.95
  /** Standing water, 0..2 of them. Terrain: never a function of the scale. */
  lakes: LakeSpec[];
  /** Bare rock, 1..2 clusters. Terrain, and the reason quarry towns exist. */
  outcrops: OutcropSpec[];
  /** sites[0] sits near the map centre and is where the day begins. */
  sites: SiteSpec[];
  /** The FULL planned road network. Roads are revealed over the day by the
   * timeline; at t=0 none of them exist visually. */
  roads: RoadSpec[];
  bridges: BridgeSpec[];
  /** Where a TRACK crosses the river instead of bridging it. Derived from the
   * same crossing pass as `bridges`, and like them a prefix under the pace
   * scale. Optional so hand-written fixtures predating fords still typecheck;
   * absent means the same as empty. */
  fords?: FordSpec[];
  /** The wild forest at t=0. Timeline events fell some of these. */
  trees: TreeSpec[];
  /** Wild non-tree scenery, present from t=0. */
  scatter: PropSpec[];
  /** 0..2 buried chests. Terrain: identical at every pace scale. Optional so
   * hand-written fixtures predating the feature still typecheck. */
  chests?: ChestSpec[];
  /* ---- ruins (additive) ------------------------------------------------- */
  /** 0..2 sets of overgrown remains. Terrain: identical at every pace scale.
   * Optional so hand-written fixtures predating the feature still typecheck. */
  ruins?: RuinSpec[];
  /* ---- end ruins (additive) --------------------------------------------- */
  /* ---- standing stones (additive) --------------------------------------- */
  /** Nought or one stone monument, and only on a moor. Terrain: identical at
   * every pace scale. Optional so hand-written fixtures predating the feature
   * still typecheck; absent means the same as empty. */
  stones?: StoneSpec[];
  /* ---- end standing stones (additive) ----------------------------------- */
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
  /** the road head walked through the shallows. Narration only — a ford has no
   * stages and gates nothing, so this never holds the road up. */
  | { t: number; type: 'ford'; fordId: string }
  | { t: number; type: 'prop'; propId: string; siteId: string } // dressing appears
  | { t: number; type: 'log'; text: string; siteId?: string } // ledger line (also emitted alongside milestones)
  | { t: number; type: 'dig'; chestId: string } // somebody's spade hits the lid
  | { t: number; type: 'discover'; chestId: string }; // the lid comes up

export interface Timeline {
  events: GenesisEvent[];
}

/* ----------------------------- derived state ----------------------------- */

export type TreeState = 'standing' | 'felling' | 'stump';
export type BuildingStatus = 'unplanned' | 'surveyed' | 'building' | 'done';
/** Missing from the map = still buried and undisturbed. */
export type ChestState = 'digging' | 'open';

export interface WorldSnapshot {
  t: number;
  /** every tree id -> state (missing = standing) */
  trees: Map<string, TreeState>;
  /* ---- living details (additive) ------------------------------------- *
   * WHEN each tree went over, not just that it did. `trees` already says a
   * tree is a stump; nothing said how long it had been one, so anything the
   * felling leaves behind — the log lying beside the stump, waiting to be
   * hauled — had no honest clock to run on. Scene-side that could only be
   * approximated as "the frame I noticed the slot flip", which is a different
   * world after a scrub to an arbitrary t; recorded here it is a pure
   * function of (seed, t) like everything else.
   *
   * Written by the existing `chop-done` event — no new event type, so
   * TYPE_RANK is untouched — and, like `trees`, it only ever grows forward.
   * ------------------------------------------------------------------- */
  /** tree id -> the t of its `chop-done` (missing = still standing/felling) */
  felled: Map<string, number>;
  /* ---- end living details (additive) --------------------------------- */
  buildings: Map<string, { status: BuildingStatus; progress: number }>;
  roads: Map<string, number>; // id -> built frac (missing = 0)
  bridges: Map<string, 0 | 1 | 2 | 3>;
  /** ford ids the road head has walked through. Nothing is drawn from this —
   * the stones are terrain — but it is what makes "narrated once" checkable. */
  fords: Set<string>;
  props: Set<string>; // site-dressing prop ids that exist
  /** chest id -> state (missing = still buried) */
  chests: Map<string, ChestState>;
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
