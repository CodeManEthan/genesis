/**
 * Genesis — artifact catalog.
 *
 * A visual inventory of every sprite the simulation can draw. Nothing here is
 * hand-drawn: every cell calls the same factory in `../vale/art.ts` (or the
 * renderer helpers in `./scene.ts`) that the live world calls, bakes it into an
 * offscreen canvas at world resolution, trims the transparent margin and blits
 * the result at ×3 with smoothing off.
 *
 * DEV-ONLY PAGE. `src/pages/catalog/[...slug].astro` returns zero static paths
 * outside `astro dev`, so this never ships.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  PAL,
  buildBird,
  buildCrane,
  buildDeer,
  buildDog,
  buildGrazingSheep,
  buildJetty,
  /* ---- the ferry (additive) ---- */
  buildPunt,
  /* ---- end the ferry (additive) ---- */
  buildNameBoard,
  buildRowboat,
  buildSignpost,
  buildStake,
  /* ---- standing stones (additive) ---- */
  buildStones,
  /* ---- end standing stones (additive) ---- */
  buildStructure,
  buildStump,
  buildTree,
  drawBot,
  drawCart,
  drawCraneLoad,
  drawFishJump,
  drawRipple,
  drawWheel,
  isoTile,
  mix,
  shade,
  /* ---- never catalogued until now: ruins, market, festival, gold ---- */
  buildBonfire,
  buildBunting,
  buildMarketStall,
  buildRubble,
  buildRuinWall,
  drawBonfire,
  drawChestGlint,
  drawPanner,
  giltStructure,
  /* ---- wildlife round two, and how the eclipse finds it ---- */
  buildCattle,
  buildDuck,
  buildFox,
  buildHorse,
  buildPerchedBird,
  /* ---- boats underway: the two figures drawn over a baked hull ---- */
  drawPunter,
  drawRower,
  /* ---- living details II: the lean is a transform over the standing art ---- */
  drawLeaningTree,
  type BotAction,
  type BuildMaterial,
  type Ctx,
  type RuinArt,
  type Sprite,
  type StructureSpec,
} from '../vale/art';
import {
  bakeLake,
  /* ---- more day types: the river's three moods, and what rides on one ---- */
  bakeRiver,
  drawFlotsam,
  paintStars,
  /* ---- end more day types ---- */
  drawBridge,
  drawFirefly,
  drawFord,
  fireflyBlink,
  makePools,
  outcropTint,
  paintRoad,
  skyAt,
  strip,
} from './scene';
import {
  ACCENTS,
  COMMON_ROLES,
  /* ---- the ferry (additive) ---- */
  FERRY_LEN,
  /* ---- end the ferry (additive) ---- */
  FLAVOUR_PROPS,
  LANDMARK_ROLES,
  QUARRY_REACH,
  THATCH_ROLES,
  WOOD_CHARACTER_NAMES,
  sampleLake,
} from './gen';
import {
  DAY_TYPES,
  PLAIN_DAY,
  riverMood,
  starsAt,
  type DayInfo,
  type DayType,
  type Season,
} from './daytype';
/* ---- living details II (additive): the fall is arithmetic, in living.ts ---- */
import { LEAN_FOR, leanOf } from './living.ts';
import { isoX, isoY, type Biome, type RoofStyle, type StructureRole, type TreeKind, type Vec2 } from './types';

/* ------------------------------ enumerations ----------------------------- */

/** Mirrors the StructureRole union in types.ts, in declaration order. */
const ROLES: StructureRole[] = [
  'cottage', 'house', 'hall', 'barn', 'workshop', 'store', 'chapel', 'tower',
  'mill', 'granary', 'smithy', 'shed', 'bakery', 'brewhouse', 'homestead',
  'gildhall',
];

/**
 * Roles that get NO special-case art inside `buildStructure` — they draw the
 * plain house and are told apart only by size, roof and the spec flags
 * (chimney / awning / banner / cupola). Down to one: `house` is the honest
 * default every other role is now a departure from. See the `role ===` branches
 * in src/components/designs/vale/art.ts (`buildStructure`, "role furniture") —
 * homestead, chapel, hall, store, workshop and cottage each have their own,
 * on top of tower, granary, mill, smithy, bakery, brewhouse and gildhall. barn,
 * shed and granary additionally get timber walls (`woody`), and barn alone gets
 * plank seams and no ground-floor window on its right face.
 */
const GENERIC_ROLES = new Set<StructureRole>(['house']);
/** Roles whose only distinction is the timber wall treatment. */
const WOODY_ONLY = new Set<StructureRole>(['shed']);
/**
 * Roles no roster can draw. A gildhall is only ever raised on a charter dug out
 * of a buried chest, which is why it is allowed a silhouette — gilt ridge, gilt
 * eaves, a ridge lamp and a plaque — that no ordinary plot can have.
 */
const CHEST_ONLY = new Set<StructureRole>(['gildhall']);

const TREE_KINDS: TreeKind[] = ['oak', 'pine', 'blossom', 'hedgerow', 'birch', 'willow', 'fir'];
const TREE_INDEX: Record<TreeKind, 0 | 1 | 2 | 3 | 4 | 5 | 6> = {
  oak: 0, pine: 1, blossom: 2, hedgerow: 3, birch: 4, willow: 5, fir: 6,
};

const BIOMES: Biome[] = ['meadow', 'forest', 'farm', 'wetland', 'moor'];

/** Non-tree pool kinds, in `makePools()` order (scene.ts). */
const PROP_POOLS = [
  'bush', 'rock', 'flowers', 'reeds', 'stump', 'crop', 'haystack', 'fenceL',
  'fenceR',
  // The stone forms, next to the timber they replace: a quarry town walls its
  // fields and stands its lamps on dressed block. Same footprint, same anchor.
  'drystoneL', 'drystoneR',
  'shed', 'cart', 'crates', 'lumber', 'barrels', 'well', 'lamp', 'lamp-stone',
  'sheep', 'campfire',
  // The stone yard of a quarry town: dressed blocks waiting to go up.
  'quarry-blocks',
];

/**
 * Buried treasure. Never a PropSpec — chests are their own list on the map, and
 * nothing resolves them by kind — but pooled all the same, so they belong on
 * this shelf. The timeline walks a chest along them: mound → dug open → open.
 */
const TREASURE_POOLS = ['chest-buried', 'chest-closed', 'chest-open'];

/** Kinds not in the pools — built on demand by `propSprite()` in scene.ts. */
const EXTRA_PROPS = ['nameboard', 'signpost', 'stake', 'crane', 'jetty', 'rowboat'];

/**
 * What gen.ts actually emits, so the catalog can flag the rest:
 *  - wild scatter  SCATTER_KINDS (gen.ts, "wild scatter"): bush, rock, stump,
 *    flowers, sheep, reeds — plus fenceL/fenceR from the field-fence pass, or
 *    drystoneL/drystoneR where the town nearest the panel builds in stone.
 *  - site essentials (gen.ts, site dressing): well, nameboard, lamp (or
 *    lamp-stone in a quarry town), signpost, campfire, lumber — plus
 *    quarry-blocks and crane in the stone yard of any town that came up within
 *    QUARRY_REACH of an outcrop.
 *  - flavour tail: FLAVOUR_PROPS = crop, haystack, crates, barrels, cart, shed.
 * `stake` has a builder and a propSprite case but no generator ever asks for it.
 */
const GENERATED = new Set<string>([
  'bush', 'rock', 'stump', 'flowers', 'sheep', 'reeds', 'fenceL', 'fenceR',
  'well', 'nameboard', 'lamp', 'signpost', 'campfire', 'lumber',
  // The stone the material reaches past the walls into: field walls on a quarry
  // town's lanes, and its lamps on dressed posts.
  'drystoneL', 'drystoneR', 'lamp-stone',
  // The stone yard, emitted with the essentials so it survives every pace.
  'quarry-blocks', 'crane',
  // The water. A town whose rim reaches a bank gets a pier and a boat with the
  // essentials; big lakes carry a free boat or two as wild scatter.
  'jetty', 'rowboat',
  // The three states of a buried chest. gen.ts emits 0..2 ChestSpecs a day and
  // the timeline moves them between these sprites.
  ...TREASURE_POOLS,
  ...FLAVOUR_PROPS,
]);

const ACCENT = '#63c9a8';

/* -------------------------------- plumbing -------------------------------- */

const SCALE = 3;

function bake(w: number, h: number, ox: number, oy: number, draw: (ctx: Ctx) => void): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.translate(Math.round(ox), Math.round(oy));
  draw(ctx);
  return c;
}

/** Bounding box of the non-transparent pixels, padded and clamped. */
function bbox(src: HTMLCanvasElement, pad = 1): { x: number; y: number; w: number; h: number } {
  const full = { x: 0, y: 0, w: src.width, h: src.height };
  const ctx = src.getContext('2d')!;
  const { width: w, height: h } = src;
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return full;
  }
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return full;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y1 = Math.min(h - 1, y1 + pad);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Crop the transparent margin a sprite exports around its art. */
function trim(src: HTMLCanvasElement, pad = 1): HTMLCanvasElement {
  const b = bbox(src, pad);
  if (b.w === src.width && b.h === src.height) return src;
  const out = document.createElement('canvas');
  out.width = b.w;
  out.height = b.h;
  const o = out.getContext('2d')!;
  o.imageSmoothingEnabled = false;
  o.drawImage(src, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  return out;
}

interface Item {
  key: string;
  label: string;
  sub?: string;
  tag?: string;
  tagKind?: 'generic' | 'unused' | 'info';
  /** Blit magnification. ×3 unless the cell is a slab of terrain rather than a
   * sprite, in which case it would swamp the sheet at that size. */
  scale?: number;
  c: HTMLCanvasElement;
}

const item = (key: string, label: string, c: HTMLCanvasElement, extra: Partial<Item> = {}): Item =>
  ({ key, label, c: trim(c), ...extra });

/** Blit one baked sprite at ×3, pixels hard. */
function Pix({ c, scale = SCALE }: { c: HTMLCanvasElement; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.width = c.width * scale;
    el.height = c.height * scale;
    const g = el.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, el.width, el.height);
    g.drawImage(c, 0, 0, c.width, c.height, 0, 0, el.width, el.height);
  }, [c, scale]);
  return <canvas ref={ref} className="pix" />;
}

function Cell({ it }: { it: Item }) {
  return (
    <figure className="cell">
      <div className="art">
        <Pix c={it.c} scale={it.scale} />
      </div>
      <figcaption>
        <span className="name">{it.label}</span>
        {it.sub && <span className="sub">{it.sub}</span>}
        {it.tag && <span className={`tag ${it.tagKind ?? 'info'}`}>{it.tag}</span>}
      </figcaption>
    </figure>
  );
}

function Row({ title, note, items }: { title?: string; note?: string; items: Item[] }) {
  return (
    <div className="row">
      {title && <h3>{title}</h3>}
      {note && <p className="note">{note}</p>}
      <div className="grid">
        {items.map((it) => (
          <Cell key={it.key} it={it} />
        ))}
      </div>
    </div>
  );
}

function Section({
  id,
  title,
  count,
  blurb,
  children,
}: {
  id: string;
  title: string;
  count: number;
  blurb: string;
  children: ReactNode;
}) {
  return (
    <section id={id}>
      <h2>
        {title}
        <span className="count">{count}</span>
      </h2>
      <p className="blurb">{blurb}</p>
      {children}
    </section>
  );
}

/* ------------------------------- structures ------------------------------- */

interface RoleSpec {
  w: number;
  floors: 1 | 2 | 3;
  roof: RoofStyle;
  chimney?: boolean;
  awning?: boolean;
  banner?: boolean;
  cupola?: boolean;
}

/** A sensible finished specimen per role — the shape gen.ts tends to ask for. */
const SPECIMEN: Record<StructureRole, RoleSpec> = {
  cottage: { w: 32, floors: 1, roof: 'thatch', chimney: true },
  house: { w: 36, floors: 2, roof: 'gable', chimney: true },
  hall: { w: 56, floors: 2, roof: 'hip', banner: true },
  barn: { w: 48, floors: 1, roof: 'thatch' },
  // No awning on the specimen: gen.ts gives one to half of them, and a canopy
  // over the doorway hides the half-open door and the bench this role is here
  // to show. The awning itself is on the store specimen below.
  workshop: { w: 36, floors: 1, roof: 'gable' },
  store: { w: 36, floors: 2, roof: 'hip', awning: true },
  chapel: { w: 40, floors: 2, roof: 'gable', cupola: true },
  tower: { w: 44, floors: 2, roof: 'hip', banner: true },
  mill: { w: 48, floors: 2, roof: 'gable', chimney: true },
  granary: { w: 44, floors: 2, roof: 'gable' },
  smithy: { w: 40, floors: 1, roof: 'hip', chimney: true },
  shed: { w: 28, floors: 1, roof: 'thatch' },
  bakery: { w: 40, floors: 1, roof: 'gable', chimney: true },
  brewhouse: { w: 44, floors: 2, roof: 'hip', chimney: true },
  homestead: { w: 44, floors: 2, roof: 'gable', chimney: true, banner: true },
  gildhall: { w: 52, floors: 3, roof: 'gable', banner: true },
};

function structure(
  role: StructureRole,
  spec: RoleSpec,
  accent: string,
  progress: number,
  lit: boolean,
  seed: number,
  roof?: RoofStyle,
  material?: BuildMaterial
): HTMLCanvasElement {
  const sp = buildStructure({
    role,
    accent,
    w: spec.w,
    floors: spec.floors,
    roof: roof ?? spec.roof,
    progress,
    condition: 1,
    material,
    chimney: spec.chimney,
    cupola: spec.cupola,
    awning: spec.awning,
    banner: spec.banner,
    lit,
    seed,
  });
  // The waterwheel lives outside the baked layer because it turns, so it is
  // allowed to overhang the sprite; give it room and freeze one on the
  // specimen, or a mill does not read as a mill.
  if (sp.wheel) {
    const out = document.createElement('canvas');
    out.width = sp.c.width + 32;
    out.height = sp.c.height + 16;
    const g = out.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.drawImage(sp.c, 0, 0);
    g.translate(sp.ox, sp.oy);
    drawWheel(g, sp.wheel[0], sp.wheel[1], 1.4);
    return out;
  }
  return sp.c;
}

const spriteCanvas = (sp: Sprite): HTMLCanvasElement => sp.c;

/* ------------------------------ infrastructure ---------------------------- */

function bridgeCanvas(stage: 1 | 2 | 3, material?: BuildMaterial): HTMLCanvasElement {
  // A straight reach of river running along +gx/+gy, so the deck crosses it
  // left-to-right on screen.
  const river: Vec2[] = [
    [-5, -5],
    [5, 5],
  ];
  return bake(150, 66, 75, 40, (ctx) => {
    drawBridge(ctx, river, 0, 0, 4, stage, material);
  });
}

function fordCanvas(): HTMLCanvasElement {
  // Same reach of river as the bridge tile, with the track that fords it laid
  // underneath — a ford is drawn over the road, so drawing it over bare water
  // would not be the thing the renderer actually produces.
  const river: Vec2[] = [
    [-5, -5],
    [5, 5],
  ];
  const road: Vec2[] = [
    [-3, 3],
    [0, 0],
    [3, -3],
  ];
  return bake(150, 66, 75, 40, (ctx) => {
    // The water through the renderer's own river bake rather than a hand-rolled
    // stack of strips, so a change to the banks reaches this cell too.
    bakeRiver(ctx, river, RIVER_W, riverMood(PLAIN_DAY));
    paintRoad(ctx, road, 'track', 0.4, 2024);
    drawFord(ctx, river, 0, 0, 3.4);
  });
}

/* ---- the ferry (additive) ------------------------------------------------ */

/** Tile space from the (u, v) the ferry's geometry is stated in. */
const fromUV = (u: number, v: number): Vec2 => [(v + u) / 2, (v - u) / 2];

/**
 * The whole crossing in one cell: two landing stages facing each other across
 * the water, and the punt out in the stream between them.
 *
 * The stages are `buildJetty` at FERRY_LEN — the ferry has no landing art of
 * its own, deliberately: a landing IS a short pier, and giving it a second
 * sprite would be two things to keep in step for no gain. The punt is not a
 * pier and is not a rowboat, and that is where the art does diverge.
 */
function ferryCanvas(): HTMLCanvasElement {
  const river: Vec2[] = [
    [-5, -5],
    [0, 0],
    [5, 5],
  ];
  // The landward roots. A root sits FERRY_LEN back from the bank, so the deck
  // head lands on the water's edge: the bank is at the water's own half-width
  // measured perpendicular, which is RIVER_W * sqrt(2) along u.
  const root = RIVER_W * Math.SQRT2 + FERRY_LEN;
  const [ax, ay] = fromUV(-root, 0);
  const [bx, by] = fromUV(root, 0);
  return bake(230, 150, 115, 78, (ctx) => {
    const jitter = [0.0, -0.035, 0.04, -0.015];
    for (let v = -10; v <= 10; v++) {
      for (let u = -8; u <= 8; u++) {
        if ((u + v) & 1) continue;
        const h = (Math.imul(u | 0, 374761393) ^ Math.imul(v | 0, 668265263)) >>> 0;
        isoTile(ctx, u * 16, v * 8, shade(PAL.biome.meadow, jitter[h % 4]));
      }
    }
    bakeRiver(ctx, river, RIVER_W, riverMood(PLAIN_DAY));
    const put = (sp: Sprite, gx: number, gy: number) =>
      ctx.drawImage(sp.c, Math.round(isoX(gx, gy) - sp.ox), Math.round(isoY(gx, gy) - sp.oy));
    put(buildJetty(0, FERRY_LEN, 131), ax, ay);
    put(buildJetty(Math.PI, FERRY_LEN, 138), bx, by);
    put(buildPunt(0, 131), 0, 0);
    drawPunter(ctx, isoX(0, 0), isoY(0, 0), 0, 1.1, '#6cc4d9');
  });
}

/* ---- end the ferry (additive) -------------------------------------------- */

const ROAD_KINDS: { kind: 'highway' | 'lane' | 'track'; width: number }[] = [
  { kind: 'highway', width: 0.62 },
  { kind: 'lane', width: 0.5 },
  { kind: 'track', width: 0.4 },
];

function roadCanvas(kind: 'highway' | 'lane' | 'track', width: number): HTMLCanvasElement {
  // Along -gy/+gx the road runs flat across the screen: four tiles of it.
  const pts: Vec2[] = [
    [-2, 2],
    [-0.7, 0.7],
    [0.7, -0.7],
    [2, -2],
  ];
  return bake(152, 56, 76, 28, (ctx) => {
    for (let u = -3; u <= 3; u++) {
      for (let v = -1; v <= 1; v++) {
        if ((u + v) & 1) continue;
        isoTile(ctx, u * 16, v * 8, PAL.biome.meadow);
      }
    }
    paintRoad(ctx, pts, kind, width, 2024 + kind.length * 31);
  });
}

function biomeCanvas(b: Biome): HTMLCanvasElement {
  const base = PAL.biome[b];
  // Same per-tile jitter table the ground bake uses, so the swatch has the
  // valley's texture and not just its flat tint.
  // A 3x3 block of tiles, which is a solid diamond on screen.
  return bake(100, 52, 50, 26, (ctx) => {
    const jitter = [0.0, -0.035, 0.04, -0.015];
    let i = 0;
    for (let gy = -1; gy <= 1; gy++) {
      for (let gx = -1; gx <= 1; gx++) {
        isoTile(ctx, (gx - gy) * 16, (gx + gy) * 8, shade(base, jitter[i++ % 4]));
      }
    }
  });
}

/* -------------------------------- terrain --------------------------------- */

/**
 * A lake of its own, on a field of meadow: `sampleLake()` builds a real
 * LakeSpec out of the generator's shape machinery and `bakeLake()` lays down
 * exactly the six strips the ground bake lays down, foam and glints included.
 */
function lakeCanvas(seed: number): HTMLCanvasElement {
  return bake(168, 112, 84, 56, (ctx) => {
    const jitter = [0.0, -0.035, 0.04, -0.015];
    for (let v = -7; v <= 7; v++) {
      for (let u = -5; u <= 5; u++) {
        if ((u + v) & 1) continue;
        const h = (Math.imul(u | 0, 374761393) ^ Math.imul(v | 0, 668265263)) >>> 0;
        isoTile(ctx, u * 16, v * 8, shade(PAL.biome.meadow, jitter[h % 4]));
      }
    }
    bakeLake(ctx, sampleLake(seed, 2.4, 1.8));
  });
}

/**
 * The ground under an outcrop at one strength of `rocky`: the biome tint pulled
 * towards bare stone by `outcropTint()`, which is the only thing that tells a
 * quarry apart from a suspiciously tidy pile of stones on a lawn.
 */
function outcropCanvas(rocky: number): HTMLCanvasElement {
  return bake(100, 52, 50, 26, (ctx) => {
    const jitter = [0.0, -0.035, 0.04, -0.015];
    let i = 0;
    for (let gy = -1; gy <= 1; gy++) {
      for (let gx = -1; gx <= 1; gx++) {
        const base = shade(PAL.biome.moor, jitter[i++ % 4]);
        isoTile(ctx, (gx - gy) * 16, (gx + gy) * 8, outcropTint(base, rocky));
      }
    }
  });
}

const SEASONS: Season[] = ['winter', 'spring', 'summer', 'autumn'];

/* ---- more day types (additive): the water ------------------------------- */

/**
 * `map.riverWidth` is a CONSTANT in gen.ts — every valley's river is the same
 * width, and the scarcity a ferry needs comes from how far a reach of it runs
 * from the nearest crossing, not from how wide it is. Kept here as a named
 * number so the three moods below are drawn at the width the world uses.
 */
const RIVER_W = 0.95;

/**
 * A straight reach of river, two segments of it, running along +gx/+gy — which
 * on an isometric screen is straight down the middle. Two segments rather than
 * one because the foam is drawn per segment, and a single-segment river would
 * show half the flecks a real one carries.
 */
const REACH: Vec2[] = [
  [-3, -3],
  [0, 0],
  [3, 3],
];

/** Terrain slabs blit at ×2: at the sheet's ×3 a flooded river is 450px of
 * cell and everything else on the shelf disappears beside it. */
const SLAB = 2;

/**
 * One reach of river, painted for one day.
 *
 * `bakeRiver()` is literally the ground bake's river block — lifted out of
 * `buildGenesisSceneSteps` so this page cannot describe a river the world does
 * not lay down — and `riverMood()` is the whole of the flood/drought mechanism:
 * three multipliers, (1, 1, 1) on every ordinary day.
 */
function riverCanvas(day: DayInfo): HTMLCanvasElement {
  return bake(200, 112, 100, 56, (ctx) => {
    const jitter = [0.0, -0.035, 0.04, -0.015];
    for (let v = -8; v <= 8; v++) {
      for (let u = -7; u <= 7; u++) {
        if ((u + v) & 1) continue;
        const h = (Math.imul(u | 0, 374761393) ^ Math.imul(v | 0, 668265263)) >>> 0;
        isoTile(ctx, u * 16, v * 8, shade(PAL.biome.meadow, jitter[h % 4]));
      }
    }
    bakeRiver(ctx, REACH, RIVER_W, riverMood(day));
  });
}

/** One piece of what a flood is carrying, on a scrap of its own water. */
function flotsamCanvas(kind: 0 | 1 | 2): HTMLCanvasElement {
  return bake(28, 20, 14, 12, (ctx) => {
    ctx.fillStyle = PAL.water;
    ctx.fillRect(-14, -12, 28, 20);
    ctx.fillStyle = PAL.waterDeep;
    ctx.fillRect(-14, 2, 28, 6);
    drawFlotsam(ctx, 0, 0, kind, 0);
  });
}

/* ---- end more day types (additive) -------------------------------------- */

/* ---- living details II (additive): a tree going over --------------------- */

/**
 * One tree at one moment of its fall.
 *
 * There is no art here at all, which is the point: `leanOf()` hands back a
 * horizontal shear about the foot of the trunk and a squash, and the STANDING
 * sprite is drawn through them. A shear rather than a rotation because every
 * tree carries its own flat ground shadow at that anchor — rotate it and the
 * shadow tips up into the air with the crown.
 */
function leanCanvas(kind: TreeKind, phase: number, dir: number): HTMLCanvasElement {
  const sp = buildTree(TREE_INDEX[kind], 11 + kind.length * 13);
  const { k, squash } = leanOf(kind, dir, phase);
  const reach = Math.ceil(Math.abs(k) * sp.c.height) + 4;
  return bake(sp.c.width + reach * 2, sp.c.height + 4, sp.ox + reach, sp.oy, (ctx) => {
    drawLeaningTree(ctx, sp, 0, 0, k, squash);
  });
}

/* ---- end living details II (additive) ------------------------------------ */

/**
 * What each day type owns in this catalog — which is the honest measure of how
 * much ART a day type is, as against how much narration.
 */
const DAY_TYPE_ART: Record<DayType, string> = {
  normal: 'everything below is the ordinary day; two thirds of seeds.',
  mist: 'a screen-space fog wash until mid-morning. No sprite of its own.',
  eclipse: 'bends the Sky curve (see above) so the lamps light at two in the afternoon — and the only day type the WILDLIFE reads: hunkered birds, deer that do not bolt, huddled stock, a daylight fox.',
  storm: 'a rain curtain and a dimmed sky, plus the one real time-warp in the world. No sprite of its own.',
  aurora: 'screen-space curtains over the night. No sprite of its own.',
  market: 'stalls in a town square and extra traffic on the roads between — see Occasions.',
  stars: 'six analytic lanes of meteor, screen-space, over the finished frame.',
  flood: 'a wider river, a silt band outside the banks, and eight pieces of wreckage going past.',
  drought: 'a thread of water in an unmoved channel, a dry gravel bed, a damp centre line and nine stones a segment.',
};

/* ---- ruins (never catalogued) -------------------------------------------- */

/** What is left of whoever was here before. `standing` is how much of the old
 * wall height is still up; below about a third it is a footing, not a wall. */
const RUINS: (RuinArt & { label: string; sub: string })[] = [
  { kind: 'corner', w: 40, floors: 2, standing: 0.45, seed: 3311, label: 'corner', sub: 'two faces, one quoin · 45% up' },
  { kind: 'corner', w: 40, floors: 2, standing: 0.45, material: 'stone', seed: 3311, label: 'corner · stone', sub: 'the same wall, quarried' },
  { kind: 'tower', w: 32, floors: 2, standing: 0.4, seed: 4477, label: 'tower', sub: 'a notched drum · 40% of shaft + storeys' },
  { kind: 'tower', w: 32, floors: 3, standing: 0.6, material: 'stone', seed: 4477, label: 'tower · stone', sub: 'taller, and more of it left' },
];

/* ---- end ruins ----------------------------------------------------------- */

/* ---------------------------------- sky ----------------------------------- */

/** The three day types that bend the light itself, plus an ordinary day. */
const SKY_DAYS: { key: string; label: string; note: string; day: DayInfo; mark?: [number, number] }[] = [
  { key: 'normal', label: 'normal', note: 'midnight → midnight', day: PLAIN_DAY },
  {
    key: 'eclipse',
    label: 'eclipse',
    note: '13:27 → 14:12 · night crosses its threshold, so lamps light at two in the afternoon',
    day: { type: 'eclipse', season: 'summer', from: 13.45, to: 14.2 },
    mark: [13.45, 14.2],
  },
  {
    key: 'storm',
    label: 'storm',
    note: '14:00 → 15:45 · deliberately stops short of the lamp threshold — a wet afternoon is dim, not dark',
    day: { type: 'storm', season: 'summer', from: 14, to: 15.75 },
    mark: [14, 15.75],
  },
];

const SKY_W = 480;
const SKY_H = 34;

/**
 * `skyAt()` across a whole day, applied the way `renderGenesis` applies it: a
 * multiply fill at `a` over the valley's own green, then the horizon wash at
 * `lift`. One pixel column per two and a half minutes.
 */
function skyStrip(day: DayInfo, from = 0, to = 24): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = SKY_W;
  c.height = SKY_H;
  const g = c.getContext('2d')!;
  for (let x = 0; x < SKY_W; x++) {
    const t = from + ((x + 0.5) / SKY_W) * (to - from);
    const sky = skyAt(t, day);
    g.fillStyle = PAL.biome.meadow;
    g.fillRect(x, 0, 1, SKY_H);
    if (sky.a > 0.002) {
      g.save();
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = sky.a;
      g.fillStyle = sky.css;
      g.fillRect(x, 0, 1, SKY_H);
      g.restore();
    }
    if (sky.lift > 0.004) {
      const grad = g.createLinearGradient(0, 0, 0, SKY_H);
      const cool = t < 12;
      grad.addColorStop(0, cool ? 'rgba(126,158,214,1)' : 'rgba(255,180,99,1)');
      grad.addColorStop(1, cool ? 'rgba(126,158,214,0)' : 'rgba(255,180,99,0)');
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = sky.lift;
      g.fillStyle = grad;
      g.fillRect(x, 0, 1, SKY_H);
      g.restore();
    }
    // A hairline along the bottom wherever the lamps are earning their keep.
    if (sky.lamps > 0.02) {
      g.globalAlpha = Math.min(1, sky.lamps);
      g.fillStyle = '#f0c75e';
      g.fillRect(x, SKY_H - 2, 1, 2);
      g.globalAlpha = 1;
    }
  }
  return c;
}

/** Decimal hours as a clock reading: 13.45 → 13:27. */
function hhmm(h: number): string {
  const m = Math.round((h % 1) * 60);
  return `${Math.floor(h)}:${String(m).padStart(2, '0')}`;
}

function SkyStrip({ day, from, to, hours }: { day: DayInfo; from?: number; to?: number; hours: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const c = skyStrip(day, from ?? 0, to ?? 24);
    el.width = c.width;
    el.height = c.height;
    el.getContext('2d')!.drawImage(c, 0, 0);
  }, [day, from, to]);
  const a = from ?? 0;
  const b = to ?? 24;
  return (
    <div className="sky">
      <canvas ref={ref} />
      <div className="ticks">
        {hours.map((h) => (
          <span key={h} style={{ left: `${((h - a) / (b - a)) * 100}%` }}>
            {h % 1 === 0 ? `${h}` : hhmm(h)}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---- more day types (additive): the shower ------------------------------- */

/** The night the stars fall on, and the hour of it this panel is showing. */
const STAR_DAY: DayInfo = { type: 'stars', season: 'summer', from: 21.4, to: 24 };
const STAR_AT = 22.6;
const STARS_W = 420;
const STARS_H = 150;
/** How long the composited panel beside the live one holds its shutter open. */
const STAR_EXPOSURE = 40;
const STAR_SEED = 4711;

/**
 * The meteor shower, on the sky it is actually drawn on.
 *
 * SCREEN-SPACE, in device pixels, over the finished frame — the same layer the
 * aurora is on — so this panel is a slab of valley green under the night
 * multiply with `paintStars` over the top, and not a sprite. That green is the
 * whole reason the streak is drawn twice: a single hairline of white over a
 * valley that is dark green under a multiply is invisible, and the wide dim
 * bloom under the narrow bright one is what makes it read as light.
 *
 * Every lane is an analytic function of the clock, so a paused panel is
 * identical to itself and reduced motion simply holds one frame.
 */
function StarsPanel() {
  const still =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const live = useRef<HTMLCanvasElement>(null);
  const long = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const sky = skyAt(STAR_AT, STAR_DAY);
    const a = starsAt(STAR_DAY, STAR_AT);
    const night = (g: Ctx) => {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = PAL.biome.meadow;
      g.fillRect(0, 0, STARS_W, STARS_H);
      g.save();
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = sky.a;
      g.fillStyle = sky.css;
      g.fillRect(0, 0, STARS_W, STARS_H);
      g.restore();
    };

    // The long exposure: forty seconds of the same six lanes, sampled every
    // third of a second onto one canvas. Not what a frame looks like — a frame
    // is usually empty, which is the honest answer to "how much shower is
    // there" — but the only way to see the whole shape of the thing at once.
    const le = long.current;
    if (le) {
      le.width = STARS_W;
      le.height = STARS_H;
      const g = le.getContext('2d')!;
      night(g);
      for (let c = 0; c < STAR_EXPOSURE; c += 0.34) {
        paintStars(g, a, STARS_W, STARS_H, c, 1, STAR_SEED);
      }
    }

    const el = live.current;
    if (!el) return;
    el.width = STARS_W;
    el.height = STARS_H;
    const g = el.getContext('2d')!;
    const paint = (clock: number) => {
      night(g);
      paintStars(g, a, STARS_W, STARS_H, clock, 1, STAR_SEED);
    };
    if (still) {
      paint(0);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      paint((now - t0) / 1000);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [still]);
  return (
    <div className="starpair">
      <figure>
        <canvas ref={live} className="stars" />
        <figcaption>one frame · about a third of a star alight at any instant</figcaption>
      </figure>
      <figure>
        <canvas ref={long} className="stars" />
        <figcaption>{STAR_EXPOSURE}s of the same six lanes, composited</figcaption>
      </figure>
    </div>
  );
}

/* ---- end more day types (additive) --------------------------------------- */

/* -------------------------------- animated -------------------------------- */

interface Anim {
  key: string;
  label: string;
  sub?: string;
  w: number;
  h: number;
  ox: number;
  oy: number;
  draw: (ctx: Ctx, t: number) => void;
}

function AnimCell({ a, t }: { a: Anim; t: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const buf = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = a.w;
    c.height = a.h;
    return c;
  }, [a.w, a.h, a.key]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const b = buf.getContext('2d')!;
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.clearRect(0, 0, buf.width, buf.height);
    b.imageSmoothingEnabled = false;
    b.translate(Math.round(a.ox), Math.round(a.oy));
    a.draw(b, t);
    el.width = buf.width * SCALE;
    el.height = buf.height * SCALE;
    const g = el.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, el.width, el.height);
    g.drawImage(buf, 0, 0, buf.width, buf.height, 0, 0, el.width, el.height);
  }, [a, t, buf]);
  return (
    <figure className="cell">
      <div className="art">
        <canvas ref={ref} className="pix" />
      </div>
      <figcaption>
        <span className="name">{a.label}</span>
        {a.sub && <span className="sub">{a.sub}</span>}
      </figcaption>
    </figure>
  );
}

const FROZEN = 0.6;

function Inhabitants({ anims }: { anims: Anim[] }) {
  const still =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [t, setT] = useState(FROZEN);
  useEffect(() => {
    if (still) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let clock = FROZEN;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      acc += (now - last) / 1000;
      last = now;
      if (acc < 0.125) return; // ~8fps is plenty for a contact sheet
      clock += acc;
      acc = 0;
      setT(clock);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [still]);
  return (
    <div className="row">
      {still && <p className="note">Reduced motion: frozen at a representative phase.</p>}
      <div className="grid">
        {anims.map((a) => (
          <AnimCell key={a.key} a={a} t={t} />
        ))}
      </div>
    </div>
  );
}

/* --------------------------------- notes ---------------------------------- */

const COVERAGE: { head: string; body: string }[] = [
  {
    head: 'shed is the last role with no art of its own',
    body:
      'Every role now draws something only it draws, except house — the deliberate baseline — and shed, which is still a small house with timber walls. A lean-to roof, an open front or a stack of tools would separate it from a cottage without costing much; at w24–28 there is not a lot of wall to spend on.',
  },
  {
    head: 'Only the door wall is dressed',
    body:
      'Almost every new piece of role furniture — porch, notice board, crates, bench, hanging sign, window boxes — hangs off the two faces the camera can see. The two back faces are blank render on every building in the valley, which is right for the fixed camera and wrong the moment anything ever rotates it.',
  },
  {
    head: 'Stone reaches past the walls, and stops at the well',
    body:
      'material: "stone" now carries beyond the coursed walls, quoins, lintels and slate roof it used to end at. A quarry town’s lamps stand on dressed posts (lamp-stone, the same lantern at the same height, so the night halo does not move); the field runs on the lanes nearest it are drystone rather than picket, panel by panel, so a boundary between a stone parish and a timber one changes hands halfway along; and a crossing whose two towns both quarry — or which comes up within STONE_BRIDGE_REACH of bare rock — is built as piers, arch and slate-coped parapet over exactly the timber bridge’s span. What is still timber-and-render in a town of masons: the well, the nameboard, the signpost, the cart, the shed. The well is the loudest of them — a stone town drawing water out of a plank-and-shingle well head.',
  },
  {
    head: 'The flat roof is drawable and never generated',
    body:
      'drawRoof() has a full flat-roof path with a parapet and roof plant, but gen.ts only ever picks thatch / hip / gable. Either use it (a store or a hall could carry it) or drop it.',
  },
  {
    head: 'stake is dead stock',
    body:
      'buildStake() and the propSprite case exist, timeline.ts even name-checks the kind, but no generator ever emits a PropSpec with kind "stake". Survey stakes only appear inside buildStructure at low progress and at the head of an unfinished road.',
  },
  {
    head: 'spec.antenna is never set',
    body:
      'buildStructure draws a roof aerial for it; BuildingSpec has no such field, so the branch is unreachable from Genesis.',
  },
  {
    head: 'condition is pinned to 1',
    body:
      'structFor() in scene.ts always passes condition: 1, so the weathering mix (greyed walls, faded roof) never shows. A frontier holding that has stood since dawn could weather a little.',
  },
  {
    head: 'The lakes do not know what day it is',
    body:
      'The water is worked now — piers, moored hulls, rowing loops, a ferry punt, a ford — and flood and drought repaint the river under all of it. What they do not touch is standing water: a river-fed lake stays brim full while its river is a thread, because draining it would strand the jetties and beach the boats moored to them, which looks worse than leaving it. Deliberate, and still a gap. So is the rest of the day-type blind spot: the prospector kneels in mid-channel on a flood day, a ford lays its pale shallows over a dry gravel bed on a drought day, and the ferry punts across two feet of water without noticing.',
  },
  {
    head: 'The flood is three planks and the drought is nine stones',
    body:
      'Everything the two rare rivers own is in this catalog: a silt band, a gravel bed, a damp centre line, three kinds of small wreckage and a stone. Nothing bigger ever comes down — no boat torn off its mooring, no drowned tree, no hurdle wrapped round a bridge pier — and nothing on the bank reacts: no sandbags, no wet mark up a wall, no cracked mud where a field meets the water. Both days are a repainted strip and some flotsam, and they read as weather rather than as an event.',
  },
  {
    head: 'Eleven animals, one predator, and nothing indoors',
    body:
      'bird (flying and perched), deer, dog, sheep, horse, cattle, fox, duck, fish, firefly. The fox is the only thing that hunts and it hunts nothing — it crosses and is gone. Still missing from the backlog: owls or wolf-eyes at the treeline at night, rabbits at a warren, and cats on a finished windowsill. Nothing has young, and no animal is ever in or on a building except the birds on a ridge.',
  },
  {
    head: 'The eclipse is the only weather the animals read',
    body:
      'Half an hour of false dusk and the valley answers it: birds hunker on the ridge in their own sprite, deer come out and do not bolt, cattle and horses draw together, fireflies come up at the bottom of the dip and the fox walks in daylight. Nothing else in the sky gets that treatment — a storm soaks a valley whose deer graze on regardless, mist hides nothing from anybody, and no bot ever looks up. And the people do not read the eclipse either: the crews keep building through the dark.',
  },
  {
    head: 'The season repaints leaves and grass, and stops there',
    body:
      'seasonCanvas runs over the six DECIDUOUS pools and the ground tint. crop (all three ages), haystack (all three), reeds and flowers are summer art in every month, so a winter valley still has a green cornfield and a fresh-cut rick in it. The water never freezes and the ricks never sit under snow.',
  },
  {
    head: 'The fall is a transform, not a drawing',
    body:
      'The ladder runs standing → felling → leaning → stump with its log → stump — and on a road one rung further, → bare paving, because the crew laying the surface grubs the stump out as it comes to it. Three to five saplings come up on cleared ground in the evening, on the verge rather than in the lane. But the lean is the standing sprite under a shear and a squash, per kind — a fir goes over stiff and late, a willow slumps early — and not art: the crown is the same crown, sheared. A drawn half-fallen trunk, with the hinge splintered and the crown crumpled into the ground, is still missing.',
  },
  {
    head: 'Crops, hay and timber ripen; nothing else does',
    body:
      'crop, haystack and lumber are three sprites each now and move through them on the clock (hay) or on the count of chops finished within reach (timber). crates, barrels and cart are still one sprite for the whole day — a store’s crates never stack higher as the town around them does. Everything except the fields, the hay and the yards still expresses progress through buildings alone.',
  },
  {
    head: 'The log is hauled by nobody',
    body:
      'A felled trunk lies for 90 world-minutes and then stops existing. No carrier walks out to it and no cart takes it. The yard it should have gone to does now grow — but on the fraction of the wood within reach that has come down, not on any particular log arriving, so the two halves of the timber economy still only rhyme.',
  },
  {
    head: 'The ferry is the only vessel with a job',
    body:
      'A punt shuttles all day and carries up to three people. Every other hull on the water is a rowing loop that ends where it began: nothing is ever loaded, no boat takes the day’s timber anywhere, and a fishing town’s boats catch nothing that is ever seen. There is no ferryman’s hut at either landing, no chain, no toll board, and the crossing has no name — the one place in the valley with two structures facing each other over the water, and no sign that anybody lives off it.',
  },
  {
    head: 'The rivalry is a paragraph with no picture',
    body:
      'About a third of multi-town days run a time trial between two towns and the ledger keeps score, and NOTHING in the valley shows it: no pennant on the leader, no board, no crowd at the finish, not a pixel. Verified against the wave — rivalries touched daytype.ts and timeline.ts only. It is the only feature in Genesis that exists entirely in prose, and either that is the point or it wants one banner.',
  },
  {
    head: 'The pools are no longer the whole inventory',
    body:
      'Ruins, standing stones, market stalls, bunting, the bonfire, the gilded roof, the ferry, the prospector, the flood’s wreckage and the chest glint are all shelved here — and not one of them comes through makePools() or a PropSpec. Each is drawn straight into the frame by scene.ts from map or day-type data, which means this page stopped being able to enumerate the valley automatically some time ago: every one of those rows is a hand-written cell, and the next feature that draws itself the same way will be missing from here until somebody writes one for it too. That is the standing maintenance cost of the catalog, and it is worth saying out loud on the catalog.',
  },
];

/* ---------------------------------- page ---------------------------------- */

export default function Catalog() {
  const [night, setNight] = useState(false);

  const pools = useMemo(() => makePools(), []);

  const structures = useMemo(
    () =>
      ROLES.map((role, i) =>
        item(
          `st-${role}`,
          role,
          structure(role, SPECIMEN[role], ACCENTS[i % ACCENTS.length], 1, night, 1000 + i * 97),
          {
            sub: `w${SPECIMEN[role].w} · ${SPECIMEN[role].floors}f · ${SPECIMEN[role].roof}`,
            tag: GENERIC_ROLES.has(role)
              ? 'generic'
              : CHEST_ONLY.has(role)
                ? 'chest-granted only'
                : WOODY_ONLY.has(role)
                  ? 'walls only'
                  : undefined,
            tagKind: GENERIC_ROLES.has(role) ? 'generic' : 'info',
          }
        )
      ),
    [night]
  );

  /**
   * One role, both ways up. Everything a quarry town's walls do — courses,
   * staggered joints, quoins at the corner, dressed lintels over the openings —
   * plus what the roof does about it, which is turn slate.
   */
  const materials = useMemo(() => {
    const out: Item[] = [];
    out.push(
      item('mt-house-timber', 'house · timber', structure('house', SPECIMEN.house, '#6cc4d9', 1, night, 3111, 'gable', 'timber'), {
        sub: 'render + frame, accent roof',
      })
    );
    out.push(
      item('mt-house-stone', 'house · stone', structure('house', SPECIMEN.house, '#6cc4d9', 1, night, 3111, 'gable', 'stone'), {
        sub: 'courses, quoins, lintels, slate',
        tag: 'quarry town',
        tagKind: 'info',
      })
    );
    out.push(
      item('mt-cottage-timber', 'cottage · timber', structure('cottage', SPECIMEN.cottage, '#f0c75e', 1, night, 3222, 'thatch', 'timber'), {
        sub: 'a THATCH_ROLE, thatched',
      })
    );
    out.push(
      item('mt-cottage-stone', 'cottage · stone', structure('cottage', SPECIMEN.cottage, '#f0c75e', 1, night, 3222, 'hip', 'stone'), {
        sub: 'the same roll, roofed in slate',
        tag: 'thatch unreachable',
        tagKind: 'unused',
      })
    );
    // Role furniture is timber whatever the walls are made of, which on masonry
    // is exactly what it would have been: a porch, a bell-cote frame and a
    // notice board are joinery, and only the bell-cote's own wall follows the
    // building. These two are the check that nothing clashes.
    out.push(
      item('mt-homestead-stone', 'homestead · stone', structure('homestead', SPECIMEN.homestead, '#63c9a8', 1, night, 3444, 'gable', 'stone'), {
        sub: 'timber porch and washing line on masonry',
        tag: 'quarry town',
        tagKind: 'info',
      })
    );
    out.push(
      item('mt-chapel-stone', 'chapel · stone', structure('chapel', SPECIMEN.chapel, '#9b8fe8', 1, night, 3555, 'gable', 'stone'), {
        sub: 'bell gable coursed with the walls, slate cap',
        tag: 'quarry town',
        tagKind: 'info',
      })
    );
    out.push(
      item('mt-stone-build', 'stone · mid-build', structure('hall', SPECIMEN.hall, '#9b8fe8', 0.55, night, 3333, 'gable', 'stone'), {
        sub: 'progress 0.55 — masonry inside the scaffold',
      })
    );
    return out;
  }, [night]);

  const stages = useMemo(() => {
    const spec = SPECIMEN.house;
    const steps: [string, number, string][] = [
      ['plot', 0.05, 'surveyed, chalked, staked'],
      ['frame', 0.3, 'footing + timber posts'],
      ['walls', 0.55, 'infill between studs'],
      ['roofed', 0.8, 'roof on, scaffold up'],
      ['finished', 1, 'scaffold struck'],
    ];
    return steps.map(([name, p, sub]) =>
      item(`pg-${name}`, name, structure('house', spec, ACCENT, p, night, 4242), { sub })
    );
  }, [night]);

  /* ---- the prospector's one day in twenty (additive) --------------------- */

  /**
   * A gold strike, which is the only thing in the valley that repaints a
   * finished building. `giltStructure` runs OVER a baked sprite — same
   * silhouette, same anchor, gold laid along the eaves, the ridge and the
   * finial — so it costs a cache-key dimension and no new art.
   */
  const gilded = useMemo(() => {
    const gild = (role: StructureRole, accent: string, seed: number, roof: RoofStyle) => {
      const spec: StructureSpec = {
        role,
        accent,
        w: SPECIMEN[role].w,
        floors: SPECIMEN[role].floors,
        roof,
        progress: 1,
        condition: 1,
        chimney: SPECIMEN[role].chimney,
        cupola: SPECIMEN[role].cupola,
        awning: SPECIMEN[role].awning,
        banner: SPECIMEN[role].banner,
        lit: night,
        seed,
      };
      const sp = buildStructure(spec);
      giltStructure(sp, spec);
      return sp.c;
    };
    return [
      item('gd-hall-plain', 'hall', structure('hall', SPECIMEN.hall, '#9b8fe8', 1, night, 6001, 'hip'), {
        sub: 'the same hall, on an ordinary day',
      }),
      item('gd-hall', 'hall · gilded', gild('hall', '#9b8fe8', 6001, 'hip'), {
        sub: 'eaves, ridge, finial',
        tag: '1 seed in 20',
        tagKind: 'info',
      }),
      item('gd-cottage', 'cottage · gilded', gild('cottage', '#f0c75e', 6002, 'thatch'), {
        sub: 'a thatched roof takes the gold too',
        tag: '1 seed in 20',
        tagKind: 'info',
      }),
      item('gd-chapel', 'chapel · gilded', gild('chapel', '#63c9a8', 6003, 'gable'), {
        sub: 'cupola and all',
        tag: '1 seed in 20',
        tagKind: 'info',
      }),
    ];
  }, [night]);

  /* ---- end the prospector's one day in twenty (additive) ----------------- */

  const roofs = useMemo(() => {
    const kinds: RoofStyle[] = ['hip', 'gable', 'thatch', 'flat'];
    return kinds.map((r) =>
      item(`rf-${r}`, r, structure('house', SPECIMEN.house, '#ef7f93', 1, night, 777, r), {
        tag: r === 'flat' ? 'never generated' : undefined,
        tagKind: 'unused',
      })
    );
  }, [night]);

  const trees = useMemo(() => {
    const out: Item[] = [];
    for (const k of TREE_KINDS) {
      for (let s = 0; s < 4; s++) {
        out.push(
          item(`tr-${k}-${s}`, k, spriteCanvas(buildTree(TREE_INDEX[k], 11 + s * 37 + k.length * 13)), {
            sub: `seed ${s + 1}`,
          })
        );
      }
    }
    return out;
  }, []);

  const treeStates = useMemo(() => {
    const out: Item[] = [];
    for (const off of [-2, 0, 2]) {
      out.push(
        item(
          `fell-${off}`,
          'felling',
          bake(40, 48, 20 + off, 42, (ctx) => {
            const sp = buildTree(0, 48);
            ctx.drawImage(sp.c, -sp.ox, -sp.oy);
          }),
          { sub: `sway ${off > 0 ? '+' : ''}${off}px` }
        )
      );
    }
    for (let s = 0; s < 3; s++) {
      out.push(item(`stump-${s}`, 'stump', spriteCanvas(buildStump(71 + s * 11)), { sub: `seed ${s + 1}` }));
    }
    return out;
  }, []);

  /* ---- living details II (additive) -------------------------------------- */

  /**
   * The last five world-minutes of a chop, for the three kinds that fall most
   * differently. `ease` is a statement about WHEN a tree commits and `tilt`
   * about how far it reaches when it lands, so a fir is still standing to look
   * at when a willow of the same age is halfway down.
   */
  const falling = useMemo(() => {
    const out: Item[] = [];
    const kinds: [TreeKind, number, string][] = [
      ['fir', 1, 'tilt 0.90 · ease 3.0 — goes all at once'],
      ['oak', 1, 'tilt 0.62 · ease 2.0'],
      ['willow', -1, 'tilt 0.50 · ease 1.1 — leaning from the first blow'],
    ];
    for (const [kind, dir, sub] of kinds) {
      for (const p of [0, 0.4, 0.75, 1]) {
        out.push(
          item(`ln-${kind}-${p}`, kind, leanCanvas(kind, p, dir), {
            sub: p === 0 ? sub : `phase ${p.toFixed(2)}`,
          })
        );
      }
    }
    return out;
  }, []);

  /* ---- end living details II (additive) ---------------------------------- */

  const poolItems = (kinds: string[], prefix: string): Item[] => {
    const out: Item[] = [];
    for (const kind of kinds) {
      const p = pools[kind] ?? [];
      p.forEach((sp, i) =>
        out.push(
          item(`${prefix}-${kind}-${i}`, kind, spriteCanvas(sp), {
            sub: p.length > 1 ? `${i + 1}/${p.length}` : undefined,
            tag: GENERATED.has(kind) ? undefined : 'unused',
            tagKind: 'unused',
          })
        )
      );
    }
    return out;
  };

  const props = useMemo(() => poolItems(PROP_POOLS, 'pp'), [pools]);
  const treasure = useMemo(() => poolItems(TREASURE_POOLS, 'tz'), [pools]);

  /* ---- living details (additive) ---------------------------------------- */

  /** One field at three ages. Pool index is shared, so a plot keeps its
   * colour and its earth as it ripens; two of the four seeds shown. */
  const cropStages = useMemo(() => {
    const out: Item[] = [];
    const stages: [string, string][] = [
      ['crop-sprout', 'sprout · before 10:00'],
      ['crop', 'rows · 10:00–16:00'],
      ['crop-tall', 'tall · after 16:00'],
    ];
    for (let v = 0; v < 2; v++) {
      for (const [kind, sub] of stages) {
        const p = pools[kind] ?? [];
        if (p[v]) out.push(item(`cs-${v}-${kind}`, kind, spriteCanvas(p[v]), { sub }));
      }
    }
    return out;
  }, [pools]);

  /** What a felling leaves on the ground, and what comes up after it. */
  const treeAfter = useMemo(() => {
    const out: Item[] = [];
    (pools.log ?? []).forEach((sp, i) =>
      out.push(item(`lg-${i}`, 'log', spriteCanvas(sp), { sub: TREE_KINDS[i] ?? `kind ${i}` }))
    );
    (pools.sapling ?? []).forEach((sp, i) =>
      out.push(item(`sa-${i}`, 'sapling', spriteCanvas(sp), { sub: `seed ${i + 1}` }))
    );
    return out;
  }, [pools]);

  /* ---- end living details (additive) ------------------------------------ */

  /* ---- living details II (additive) -------------------------------------- */

  /** Hay and timber, each at the three ages the afternoon walks them through.
   * Pool index is shared with the middle age, exactly as the crops' is. */
  const growthStages = useMemo(() => {
    const out: Item[] = [];
    const fam: [string, string, string][][] = [
      [
        ['hay-heap', 'haystack', 'cut · +0'],
        ['hay-cock', 'haystack', 'cocked · +30 min'],
        ['haystack', 'haystack', 'ricked · +60 min'],
      ],
      [
        ['lumber-low', 'lumber', 'under half the wood down'],
        ['lumber', 'lumber', 'half the wood down'],
        ['lumber-high', 'lumber', 'nearly all of it down'],
      ],
    ];
    for (const family of fam) {
      for (let v = 0; v < 2; v++) {
        for (const [kind, label, sub] of family) {
          const p = pools[kind] ?? [];
          if (p[v]) out.push(item(`gs-${kind}-${v}`, label, spriteCanvas(p[v]), { sub }));
        }
      }
    }
    return out;
  }, [pools]);

  /* ---- end living details II (additive) ---------------------------------- */

  const extras = useMemo(() => {
    const out: Item[] = [];
    out.push(item('ex-nameboard', 'nameboard', spriteCanvas(buildNameBoard(ACCENT))));
    out.push(item('ex-signpost', 'signpost', spriteCanvas(buildSignpost(ACCENT))));
    for (let s = 0; s < 2; s++) {
      out.push(
        item(`ex-stake-${s}`, 'stake', spriteCanvas(buildStake('#ef7f93', s)), {
          sub: `seed ${s + 1}`,
          tag: 'unused',
          tagKind: 'unused',
        })
      );
    }
    out.push(
      item('ex-crane', 'crane', spriteCanvas(buildCrane('#f0c75e')), {
        sub: 'quarry yard + landmark builds',
        tag: 'generated',
        tagKind: 'info',
      })
    );
    // ADDITIVE — boats and jetties. Both are baked per BEARING rather than
    // pooled, so the shelf shows the same pier and the same boat pointing four
    // different ways: that is the whole of the variation gen.ts asks for.
    for (let q = 0; q < 4; q++) {
      const dir = (q * Math.PI) / 2 + Math.PI / 4;
      out.push(
        item(`ex-jetty-${q}`, 'jetty', spriteCanvas(buildJetty(dir, 2.2, 131)), {
          sub: `bearing ${q * 90 + 45}\u00b0`,
          tag: 'generated',
          tagKind: 'info',
        })
      );
    }
    // The two hulls in the bag, picked out by seed: seed 0 tars its boat, seed
    // 3 washes it. gen.ts hands the boat whatever seed the day gives it.
    for (const [sd, name] of [[0, 'tarred hull'], [3, 'washed hull']] as const) {
      out.push(
        item(`ex-boat-${sd}`, 'rowboat', spriteCanvas(buildRowboat(Math.PI / 4, sd)), {
          sub: name,
          tag: 'generated',
          tagKind: 'info',
        })
      );
    }
    // ADDITIVE — the ferry. A punt is not in `PropSpec.kind` at all: it is not
    // dressing, it is the moving half of `GenesisMap.ferry`, and the renderer
    // bakes one per quantised bearing. Two here, because the crossing is drawn
    // going over and coming back.
    for (const [q, name] of [[0, 'crossing out'], [4, 'coming back']] as const) {
      out.push(
        item(
          `ex-punt-${q}`,
          'punt (ferry)',
          spriteCanvas(buildPunt(Math.PI / 4 + (q * Math.PI) / 4, 11)),
          { sub: name, tag: 'generated', tagKind: 'info' }
        )
      );
    }
    return out;
  }, []);

  /* ---- drawn straight into the frame, never through a pool --------------- */

  /**
   * The day-type dressing: what a market day and a festival evening put on the
   * ground. None of these is a PropSpec and none is pooled — `daytype.ts`
   * decides where they go and `scene.ts` bakes them per site, so the only way
   * they can appear in an inventory is by hand.
   */
  const occasions = useMemo(() => {
    const out: Item[] = [];
    for (const [seed, accent] of [[517, '#ef7f93'], [833, '#63c9a8'], [211, '#f0c75e']] as const) {
      out.push(
        item(`oc-stall-${seed}`, 'market stall', spriteCanvas(buildMarketStall(seed, accent)), {
          sub: 'awning in the town accent',
          tag: 'market day',
          tagKind: 'info',
        })
      );
    }
    for (const [dx, dy, name] of [[54, -10, 'a short span'], [110, 16, 'across a square']] as const) {
      out.push(
        item(`oc-bunt-${dx}`, 'bunting', spriteCanvas(buildBunting(dx, dy, 404 + dx)), {
          sub: `${name} · sag is a property of the whole string`,
          tag: 'festival',
          tagKind: 'info',
        })
      );
    }
    out.push(
      item('oc-fire', 'bonfire (unlit)', spriteCanvas(buildBonfire(77)), {
        sub: 'the flames go on per frame — see Inhabitants',
        tag: 'festival',
        tagKind: 'info',
      })
    );
    return out;
  }, []);

  const anims = useMemo<Anim[]>(() => {
    const actions: BotAction[] = ['walk', 'carry', 'work', 'idle', 'fish'];
    const list: Anim[] = actions.map((a, i) => ({
      key: `bot-${a}`,
      label: `bot · ${a}`,
      sub: 'drawBot',
      w: 18,
      h: 24,
      ox: 9,
      oy: 21,
      draw: (ctx, t) =>
        drawBot(ctx, 0, 0, ['#ef7f93', '#63c9a8', '#9b8fe8', '#6cc4d9', '#e98fc3'][i], true, a, t),
    }));
    list.push({
      key: 'bot-left',
      label: 'bot · walk (left)',
      sub: 'faceRight = false',
      w: 18,
      h: 24,
      ox: 9,
      oy: 21,
      draw: (ctx, t) => drawBot(ctx, 0, 0, '#f0c75e', false, 'walk', t),
    });
    list.push({
      key: 'cart',
      label: 'hand cart',
      sub: 'drawCart',
      w: 40,
      h: 26,
      ox: 24,
      oy: 22,
      draw: (ctx, t) => drawCart(ctx, 0, 0, '#e98fc3', true, t, '#c8a86a'),
    });
    const crane = buildCrane('#f0c75e');
    list.push({
      key: 'crane',
      label: 'crane + load',
      sub: 'drawCraneLoad',
      w: crane.c.width,
      h: crane.c.height,
      ox: crane.ox,
      oy: crane.oy,
      draw: (ctx, t) => {
        ctx.drawImage(crane.c, -crane.ox, -crane.oy);
        drawCraneLoad(ctx, 0, 0, t);
      },
    });
    const mill = buildStructure({
      role: 'mill',
      accent: '#6cc4d9',
      w: 48,
      floors: 2,
      roof: 'gable',
      progress: 1,
      condition: 1,
      chimney: true,
      seed: 5150,
    });
    const mb = bbox(mill.c, 1);
    list.push({
      key: 'mill',
      label: 'mill wheel',
      sub: 'drawWheel',
      w: mb.w + 30,
      h: mb.h + 14,
      ox: mill.ox - mb.x + 2,
      oy: mill.oy - mb.y + 2,
      draw: (ctx, t) => {
        ctx.drawImage(mill.c, -mill.ox, -mill.oy);
        if (mill.wheel) drawWheel(ctx, mill.wheel[0], mill.wheel[1], t);
      },
    });
    list.push({
      key: 'wheel',
      label: 'wheel (bare)',
      sub: 'r = 10',
      w: 30,
      h: 30,
      ox: 15,
      oy: 15,
      draw: (ctx, t) => drawWheel(ctx, 0, 0, t),
    });

    /* ---- boats underway (additive) --------------------------------------- *
     * Both figures are drawn per frame over an ALREADY BAKED hull, at the
     * hull's own waterline anchor, which is why a heading may change as often
     * as it likes without minting a sprite: the hull is quantised to a
     * sixteen-step bearing ladder and the person on it is not quantised at all.
     * ---------------------------------------------------------------------- */
    const hull = buildRowboat(Math.PI / 4, 0);
    list.push({
      key: 'rower',
      label: 'rowboat · under way',
      sub: 'drawRower over a baked hull',
      w: hull.c.width + 26,
      h: hull.c.height + 16,
      ox: hull.ox + 13,
      oy: hull.oy + 8,
      draw: (ctx, t) => {
        ctx.drawImage(hull.c, -hull.ox, -hull.oy);
        drawRower(ctx, 0, 0, Math.PI / 4, t * 3.2, '#ef7f93');
      },
    });
    const punt = buildPunt(Math.PI / 4, 11);
    list.push({
      key: 'punter',
      label: 'punt · the ferryman',
      sub: 'drawPunter — pole down, walked back',
      w: punt.c.width + 30,
      h: punt.c.height + 22,
      ox: punt.ox + 15,
      oy: punt.oy + 16,
      draw: (ctx, t) => {
        ctx.drawImage(punt.c, -punt.ox, -punt.oy);
        drawPunter(ctx, 0, 0, Math.PI / 4, t * 2.1, '#6cc4d9');
      },
    });
    /* ---- end boats underway (additive) ----------------------------------- */

    /* ---- the prospector, the fire and the glint -------------------------- */
    // One man, every day, between GOLD_FROM and GOLD_TO: he wades to a gravel
    // bar and swirls a pan, and one day in twenty finds something. `rich` is
    // the strike, and it is the only difference between the two cells.
    for (const [rich, name] of [[false, 'an ordinary day'], [true, 'a gold strike']] as const) {
      list.push({
        key: `panner-${rich}`,
        label: `prospector · panning${rich ? ' (rich)' : ''}`,
        sub: name,
        w: 30,
        h: 28,
        ox: 15,
        oy: 22,
        draw: (ctx, t) => drawPanner(ctx, 0, 0, '#c8a86a', true, 1, t, rich),
      });
    }
    list.push({
      key: 'panner-walk',
      label: 'prospector · wading',
      sub: 'the ordinary walk, pan carried flat',
      w: 30,
      h: 28,
      ox: 15,
      oy: 22,
      draw: (ctx, t) => drawPanner(ctx, 0, 0, '#c8a86a', true, 0, t, false),
    });
    const fire = buildBonfire(77);
    list.push({
      key: 'bonfire',
      label: 'bonfire · alight',
      sub: 'buildBonfire + drawBonfire',
      w: fire.c.width + 8,
      h: fire.c.height + 8,
      ox: fire.ox + 4,
      oy: fire.oy + 4,
      draw: (ctx, t) => {
        ctx.drawImage(fire.c, -fire.ox, -fire.oy);
        drawBonfire(ctx, 0, 0, t);
      },
    });
    const mound = pools['chest-buried']?.[0];
    list.push({
      key: 'glint',
      label: 'chest · glint',
      sub: 'drawChestGlint — how a buried chest is found',
      w: 34,
      h: 34,
      ox: 17,
      oy: 22,
      draw: (ctx, t) => {
        if (mound) ctx.drawImage(mound.c, -mound.ox, -mound.oy);
        drawChestGlint(ctx, 0, 0, t);
      },
    });
    return list;
  }, [pools]);

  /**
   * The fauna. Everything below is the same builder the wildlife pass calls;
   * only the clock is this page's, so a bird flaps at ~3Hz instead of at
   * whatever its own phase is doing over the wood.
   */
  const wildlife = useMemo<Anim[]>(() => {
    const list: Anim[] = [];
    const birds = [buildBird(0), buildBird(1)];
    list.push({
      key: 'wl-bird',
      label: 'bird · flap',
      sub: 'buildBird(0|1)',
      w: 16,
      h: 16,
      ox: 8,
      oy: 8,
      draw: (ctx, t) => {
        const sp = birds[Math.floor(t * 6) % 2];
        ctx.drawImage(sp.c, -sp.ox, -sp.oy);
      },
    });
    const poses: [0 | 1 | 2, string][] = [
      [0, 'alert'],
      [1, 'grazing'],
      [2, 'bolting'],
    ];
    for (const [pose, name] of poses) {
      const sp = buildDeer(pose, true, pose === 0 ? 7 : 9);
      list.push({
        key: `wl-deer-${pose}`,
        label: `deer · ${name}`,
        sub: `pose ${pose}${pose === 0 ? ' · antlered' : ''}`,
        w: 26,
        h: 24,
        ox: 11,
        oy: 20,
        draw: (ctx) => ctx.drawImage(sp.c, -sp.ox, -sp.oy),
      });
    }
    const deerL = buildDeer(0, false, 7);
    list.push({
      key: 'wl-deer-left',
      label: 'deer · facing left',
      sub: 'faceRight = false',
      w: 26,
      h: 24,
      ox: 15,
      oy: 20,
      draw: (ctx) => ctx.drawImage(deerL.c, -deerL.ox, -deerL.oy),
    });
    const dogs = [buildDog(0, true), buildDog(1, true)];
    list.push({
      key: 'wl-dog',
      label: 'dog · trot',
      sub: 'buildDog(0|1)',
      w: 18,
      h: 18,
      ox: 8,
      oy: 14,
      draw: (ctx, t) => {
        const sp = dogs[Math.floor(t * 4) % 2];
        ctx.drawImage(sp.c, -sp.ox, -sp.oy);
      },
    });
    const sheep = [buildGrazingSheep(103, true, false), buildGrazingSheep(103, true, true)];
    list.push({
      key: 'wl-sheep',
      label: 'sheep · head up / down',
      sub: 'buildGrazingSheep',
      w: 22,
      h: 20,
      ox: 10,
      oy: 15,
      draw: (ctx, t) => {
        const sp = sheep[Math.floor(t / 1.6) % 2];
        ctx.drawImage(sp.c, -sp.ox, -sp.oy);
      },
    });
    // The arc `stepFish` integrates: launched at -34px/s under 96px/s², so it
    // is up for about seven tenths of a second and leaves a ring where it lands.
    const V0 = -34;
    const G = 96;
    const AIR = (-2 * V0) / G;
    // The ring outlives the jump by twice over, so the loop runs to the end of
    // the ring and straight back into the next fish — no dead frame in a cell
    // that only exists to show the pair.
    const LOOP = AIR + 1.5;
    list.push({
      key: 'wl-fish',
      label: 'fish · jump + ring',
      sub: 'drawFishJump / drawRipple',
      w: 40,
      h: 26,
      ox: 13,
      oy: 17,
      draw: (ctx, t) => {
        const p = t % LOOP;
        if (p < AIR) {
          const vy = V0 + G * p;
          drawFishJump(ctx, p * 12, V0 * p + 0.5 * G * p * p, vy);
        } else {
          const age = p - AIR;
          drawRipple(ctx, AIR * 12, 0, 1.5 + age * 6, Math.max(0, 1 - age / 1.5) * 0.75);
        }
      },
    });
    // Fireflies get their own night: they are drawn after the sky multiply in
    // the world precisely so nothing can dim them, and a firefly on a daylit
    // swatch is a grey pixel.
    const FLIES = [
      [10, 12, 0],
      [24, 20, 1.9],
      [38, 9, 3.4],
      [30, 30, 5.1],
      [16, 27, 2.6],
      [45, 24, 0.8],
    ];
    list.push({
      key: 'wl-firefly',
      label: 'firefly · blink',
      sub: 'drawFirefly, over the sky fill',
      w: 56,
      h: 40,
      ox: 0,
      oy: 0,
      draw: (ctx, t) => {
        ctx.fillStyle = '#1b2430';
        ctx.fillRect(0, 0, 56, 40);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const [x, y, c] of FLIES) drawFirefly(ctx, x, y, fireflyBlink(t * 3, c), 1, 1);
        ctx.restore();
        ctx.globalAlpha = 1;
      },
    });

    /* ---- wildlife, round two (additive) ---------------------------------- *
     * Drawn to one scale ladder, measured at the anchor: duck 5px · fox 10px ·
     * sheep 12px · deer 17px · cattle 17px · horse 21px. They all stand on the
     * same ground diamond, so that ladder is what the eye actually compares.
     * ---------------------------------------------------------------------- */
    for (const [seed, coat] of [[3, 'bay'], [7, 'grey']] as const) {
      const poses = [buildHorse(0, true, seed), buildHorse(1, true, seed)];
      list.push({
        key: `wl-horse-${seed}`,
        label: `horse · ${coat}`,
        sub: 'head up / down at the grass',
        w: 32,
        h: 32,
        ox: 15,
        oy: 27,
        draw: (ctx, t) => {
          const sp = poses[Math.floor(t / 2.2) % 2];
          ctx.drawImage(sp.c, -sp.ox, -sp.oy);
        },
      });
    }
    for (const [seed, name] of [[3, 'plain'], [7, 'belted']] as const) {
      const cows = [buildCattle(seed, true, false), buildCattle(seed, true, true)];
      list.push({
        key: `wl-cow-${seed}`,
        label: `cattle · ${name}`,
        sub: 'buildCattle(seed, faceRight, grazing)',
        w: 30,
        h: 26,
        ox: 14,
        oy: 21,
        draw: (ctx, t) => {
          const sp = cows[Math.floor(t / 1.9) % 2];
          ctx.drawImage(sp.c, -sp.ox, -sp.oy);
        },
      });
    }
    const foxes = [buildFox(0, true), buildFox(1, true)];
    list.push({
      key: 'wl-fox',
      label: 'fox · trot',
      sub: 'one night in three, and 7 eclipses in 10',
      w: 24,
      h: 20,
      ox: 10,
      oy: 15,
      draw: (ctx, t) => {
        const sp = foxes[Math.floor(t * 4) % 2];
        ctx.drawImage(sp.c, -sp.ox, -sp.oy);
      },
    });
    const ducks = [buildDuck(0, true), buildDuck(1, true)];
    list.push({
      key: 'wl-duck',
      label: 'duck · bob',
      sub: 'five pixels, so the frames are a head bob',
      w: 16,
      h: 14,
      ox: 7,
      oy: 9,
      draw: (ctx, t) => {
        const sp = ducks[Math.floor(t * 2.5) % 2];
        ctx.drawImage(sp.c, -sp.ox, -sp.oy);
      },
    });
    // Perching birds sit on the RIDGE of a finished roof, which is why the
    // hunkered variant keeps the same footprint and the same six-pixel origin:
    // an eclipse must not move a bird half a pixel along the tiles.
    const perched: [boolean, boolean, string, string][] = [
      [true, false, 'perched', 'facing right'],
      [false, false, 'perched', 'facing left'],
      [true, true, 'perched · hunkered', 'eclipse — head into the shoulders'],
    ];
    for (const [face, hunk, label, sub] of perched) {
      const sp = buildPerchedBird(face, hunk);
      list.push({
        key: `wl-perch-${face}-${hunk}`,
        label: `bird · ${label}`,
        sub,
        w: 12,
        h: 12,
        ox: face ? 5 : 7,
        oy: 8,
        draw: (ctx) => ctx.drawImage(sp.c, -sp.ox, -sp.oy),
      });
    }
    /* ---- end wildlife, round two (additive) ------------------------------ */
    return list;
  }, []);

  const bridges = useMemo(
    () =>
      [
        ...([1, 2, 3] as const).map((s) =>
          item(`br-${s}`, `bridge stage ${s}`, bridgeCanvas(s), {
            sub: s === 1 ? 'pilings' : s === 2 ? 'deck' : 'rails / done',
          })
        ),
        // The same crossing, same span, same footprint, built by masons: what a
        // road between two quarry towns — or any crossing that comes up within
        // STONE_BRIDGE_REACH of bare rock — puts over the water instead.
        ...([1, 2, 3] as const).map((s) =>
          item(`brs-${s}`, `stone bridge stage ${s}`, bridgeCanvas(s, 'stone'), {
            sub: s === 1 ? 'piers' : s === 2 ? 'arch + causeway' : 'parapets / done',
            tag: 'material: stone',
          })
        ),
        // What the lightest road class does instead. No stages: it is terrain
        // plus footfall, and it looks like this from midnight onwards.
        item('fd-0', 'ford', fordCanvas(), { sub: 'tracks only · no build stages' }),
      ],
    []
  );

  /* ---- more day types + the ferry (additive) ----------------------------- */

  /**
   * The same reach of the same river on the three days it can be painted for.
   * The mood is three multipliers and nothing else — the map's own `river` and
   * `riverWidth` are read and never written — so nothing under the water moves
   * between these cells: a bridge, a pier or a gravel bar is in the same place
   * in all three.
   */
  const rivers = useMemo(
    () =>
      (
        [
          [PLAIN_DAY, 'normal', '×1 water · ×1 banks · 9 flecks a segment'],
          [
            { type: 'flood', season: 'summer', from: 8, to: 19 } as DayInfo,
            'flood',
            '×1.6 water · ×1.62 banks · ×2.4 foam · silt 1.8 tiles out',
          ],
          [
            { type: 'drought', season: 'summer', from: 8, to: 19 } as DayInfo,
            'drought',
            '×0.4 water in an UNMOVED channel · dry bed at the old width · damp centre line',
          ],
        ] as const
      ).map(([day, label, sub]) =>
        item(`rv-${label}`, `river · ${label}`, riverCanvas(day), { sub, scale: SLAB })
      ),
    []
  );

  /** Eight of these ride a flood down the valley and wrap round the arclength;
   * downstream is simply the end further down the screen. */
  const flotsam = useMemo(
    () =>
      ([0, 1, 2] as const).map((k) =>
        item(`fl-${k}`, 'wreckage', flotsamCanvas(k), {
          sub: ['a length of board', 'a branch with green on it', 'what is left of a hurdle'][k],
          tag: 'flood day',
          tagKind: 'info',
        })
      ),
    []
  );

  /** The crossing whole, and the two hulls that are not the same shape. */
  const ferry = useMemo(
    () => [
      item('fy-cross', 'ferry crossing', ferryCanvas(), {
        sub: `two landings at FERRY_LEN ${FERRY_LEN}, punt amidships`,
        scale: SLAB,
      }),
      item('fy-stage', 'landing stage', spriteCanvas(buildJetty(0, FERRY_LEN, 131)), {
        sub: 'buildJetty at the ferry’s own length',
      }),
      item('fy-pier', 'pier, for scale', spriteCanvas(buildJetty(0, 2.2, 131)), {
        sub: 'a town’s jetty is more than twice as long',
      }),
      item('fy-punt', 'punt', spriteCanvas(buildPunt(0, 11)), { sub: 'flat both ends, ramped' }),
      item('fy-boat', 'rowboat, for shape', spriteCanvas(buildRowboat(0, 0)), {
        sub: 'a curve with a bow — the punt is a rectangle',
      }),
    ],
    []
  );

  /* ---- end more day types + the ferry (additive) -------------------------- */

  const roads = useMemo(
    () => ROAD_KINDS.map((r) => item(`rd-${r.kind}`, r.kind, roadCanvas(r.kind, r.width), { sub: `width ${r.width}` })),
    []
  );

  const grounds = useMemo(
    () => BIOMES.map((b) => item(`bi-${b}`, b, biomeCanvas(b), { sub: PAL.biome[b] })),
    []
  );

  const lakes = useMemo(
    () =>
      [4211, 9137].map((s, i) =>
        item(`lk-${s}`, `lake ${i + 1}`, lakeCanvas(s), {
          sub: 'sand · dark sand · shallow · water · deep · heart',
        })
      ),
    []
  );

  const outcrops = useMemo(
    () =>
      [0, 0.5, 1].map((k) =>
        item(`oc-${k}`, 'outcrop tint', outcropCanvas(k), {
          sub: k === 0 ? 'rocky 0 — plain moor' : `rocky ${k.toFixed(1)}`,
        })
      ),
    []
  );

  /**
   * Whoever was here before. Ruins are map data with no PropSpec and no pool —
   * `ruinSprite()` bakes one per RuinSpec — and one of them per day is the
   * GHOST, whose kind, size and position are a pure function of yesterday's
   * seed and are the only thread between two days of the valley.
   */
  const ruins = useMemo(
    () => [
      ...RUINS.map((r) =>
        item(`ru-${r.kind}-${r.material ?? 'timber'}-${r.floors}`, r.label, spriteCanvas(buildRuinWall(r)), {
          sub: r.sub,
        })
      ),
      ...[2911, 5507].map((s, i) =>
        item(`ru-rub-${s}`, 'rubble', spriteCanvas(buildRubble(s, 32 + i * 12)), {
          sub: `a footing and nothing standing · w${32 + i * 12}`,
        })
      ),
    ],
    []
  );

  /**
   * One oak, four times over. `makePools(season)` repaints the six deciduous
   * pools at bake, on the finished pixels, so this is literally the sprite the
   * world would draw that month.
   */
  const seasons = useMemo(
    () =>
      SEASONS.map((s) =>
        item(`sn-${s}`, s, spriteCanvas(makePools(s).oak[0]), {
          sub: s === 'summer' ? 'as drawn' : 'seasonCanvas',
        })
      ),
    []
  );

  /* ---- standing stones (additive) ---- */
  /**
   * One specimen of each monument, at the middle of the size range gen.ts
   * draws from. `buildStones` is the same factory the world bakes with, so
   * these are literally the sprites a valley with a moor might be carrying.
   */
  const monuments = useMemo(
    () =>
      (
        [
          { kind: 'circle', w: 52, count: 6, fallen: 2, rot: 0.6, seed: 8821, sub: '6 uprights, one down' },
          { kind: 'dolmen', w: 32, count: 2, fallen: -1, rot: 1.1, seed: 4519, sub: 'two and a capstone' },
          { kind: 'row', w: 48, count: 4, fallen: -1, rot: 0.35, seed: 7703, sub: '4 stones marching' },
        ] as const
      ).map((m) =>
        item(`st-${m.kind}`, m.kind, spriteCanvas(buildStones(m)), { sub: m.sub })
      ),
    []
  );
  /* ---- end standing stones (additive) ---- */

  const commonCounts = useMemo(() => {
    const m = new Map<StructureRole, number>();
    for (const r of COMMON_ROLES) m.set(r, (m.get(r) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, []);

  const counts = {
    structures: structures.length + materials.length + gilded.length + stages.length + roofs.length,
    trees: trees.length + treeStates.length + falling.length + treeAfter.length,
    props:
      props.length +
      treasure.length +
      extras.length +
      occasions.length +
      cropStages.length +
      growthStages.length,
    inhabitants: anims.length,
    wildlife: wildlife.length,
    water: rivers.length + flotsam.length + ferry.length,
    infra: bridges.length + roads.length + grounds.length,
    terrain: lakes.length + outcrops.length + ruins.length + monuments.length + seasons.length,
    palette: ACCENTS.length + SKY_DAYS.length + DAY_TYPES.length,
  };

  return (
    <div className={`cat ${night ? 'night' : ''}`}>
      <style>{CSS}</style>

      <header className="head">
        <div>
          <h1>Genesis — artifact catalog</h1>
          <p>
            Every sprite the simulation can draw, rendered by the same factories the
            world uses, ×{SCALE}, pixels hard. Dev-only page.
          </p>
        </div>
        <button className={`night ${night ? 'on' : ''}`} onClick={() => setNight((n) => !n)}>
          {night ? '🌙 night (lit)' : '☀ day'}
        </button>
      </header>

      <nav className="nav">
        <a href="#structures">Structures <b>{counts.structures}</b></a>
        <a href="#trees">Trees <b>{counts.trees}</b></a>
        <a href="#props">Props <b>{counts.props}</b></a>
        <a href="#inhabitants">Inhabitants <b>{counts.inhabitants}</b></a>
        <a href="#wildlife">Wildlife <b>{counts.wildlife}</b></a>
        <a href="#water">Water <b>{counts.water}</b></a>
        <a href="#infrastructure">Infrastructure <b>{counts.infra}</b></a>
        <a href="#terrain">Terrain <b>{counts.terrain}</b></a>
        <a href="#palette">Palette <b>{counts.palette}</b></a>
        <a href="#coverage">Coverage <b>{COVERAGE.length}</b></a>
      </nav>

      <main>
        <Section
          id="structures"
          title="Structures"
          count={counts.structures}
          blurb="buildStructure(spec) — one specimen per StructureRole, then the two materials, the universal progress ladder and the roof styles. A “generic” tag means the role has no special-case art of its own."
        >
          <Row
            title={`Roles (${ROLES.length})`}
            note={`${GENERIC_ROLES.size} of ${ROLES.length} draws the plain house — house itself, the baseline the rest depart from. homestead has a porch, woodpile, washing line and rain butt; chapel a bell gable, lancets and a double door; hall eave brackets, a notice board and a ridge finial; store a shopfront, a hanging shingle and crates; workshop a half-open cart door, a bench and a lean-to; cottage window boxes and a garden fence. A gildhall is never drawn from the common or landmark bags — it takes a charter out of a buried chest.`}
            items={structures}
          />
          <Row
            title="Materials"
            note={`spec.material — absent is 'timber'. Every plot of a town that came up within QUARRY_REACH (${QUARRY_REACH} u/v units) of an outcrop is 'stone': coursed walls with staggered joints, quoins alternating at the corner, dressed lintels over the openings, and a roof of slate mixed from the town's own accent. gen.ts short-circuits the thatch roll on stone, so no combination of seeds produces a thatched masonry cottage.`}
            items={materials}
          />
          {/* ---- the prospector's one day in twenty (additive) ---- */}
          <Row
            title={`Gold strike (${gilded.length})`}
            note="About one seed in twenty, the prospector finds something, and the nearest town's roofs are gilt for the rest of the day. giltStructure() runs over the finished sprite — gold along the two eaves the camera sees, up the ridge and out to the finial — so the building keeps its silhouette, its anchor and its cache entry, plus one dimension on the key. A gildhall is skipped: gilding the gilding reads as a bug."
            items={gilded}
          />
          {/* ---- end the prospector's one day in twenty (additive) ---- */}
          <Row title="Progress stages" note="Shared by every role — shown on a house." items={stages} />
          <Row title="Roof styles" items={roofs} />
        </Section>

        <Section
          id="trees"
          title="Trees"
          count={counts.trees}
          blurb="buildTree(kind, seed) — seven kinds, four seeds each, the states a tree can be caught in, and what its felling leaves behind."
        >
          <Row title={`Kinds (${TREE_KINDS.length})`} items={trees} />
          <Row
            title="States"
            note="A tree under the axe is the standing sprite offset ±2px; once felled it is replaced by a stump."
            items={treeStates}
          />
          {/* ---- living details II (additive) ---- */}
          <Row
            title={`Going over (${falling.length})`}
            note={`The last ${Math.round(LEAN_FOR * 60)} world-minutes of a chop, hung off the plan's own chop-done so the instant the tilt reaches full is the instant the stump and the log land. There is NO ART HERE: leanOf() hands back a horizontal shear about the foot of the trunk and a squash, and the standing sprite is drawn through them — a shear rather than a rotation because every tree carries its own flat ground shadow at that anchor, and rotating it tips the shadow into the air with the crown. Per kind: the ease is a statement about when a tree commits and the tilt about how far it reaches when it lands. The direction is the way its trunk is about to lie, off the shared logOffset.`}
            items={falling}
          />
          {/* ---- end living details II (additive) ---- */}
          {/* ---- living details (additive) ---- */}
          <Row
            title={`After the axe (${treeAfter.length})`}
            note="The trunk lies beside its stump for 90 world-minutes and is then hauled off to the yards — one log per tree kind, because the bark is all that tells them apart at this size. The stump itself outlasts the log only off the roads: a tree a ROAD claimed is grubbed out the moment the paving reaches its own point along that road, so a finished lane ends the day clear instead of carrying a line of stumps drawn over its surface. A plot's stump is nobody's paving job and stands all day. Three to five saplings come up on the day's cleared ground after 18:00, each beside a stump the day actually made — a stride or two off it and so on the verge, never on the paving, which is why the grubbing does not take the regrowth with it."
            items={treeAfter}
          />
          {/* ---- end living details (additive) ---- */}
        </Section>

        <Section
          id="props"
          title="Props & scatter"
          count={counts.props}
          blurb="Every pooled kind from makePools(), all pool variants, plus the four built on demand by propSprite(). “unused” means gen.ts never emits it. The log and sapling pools are shelved with the trees, whose felling is the only thing that asks for them."
        >
          <Row title={`Pools (${PROP_POOLS.length} kinds)`} items={props} />
          {/* ---- living details (additive) ---- */}
          <Row
            title="Crop stages (3)"
            note="The one prop that is not a single sprite. A plot is sprouts before ~10:00, the rows that have always been here until ~16:00, and tall gold after — the stage is a pure function of the clock and a ±40-minute jitter off the plot's own seed, so a valley's fields do not all turn on the same stroke. All three stages share a pool index, so a field keeps its colour and its earth as it ripens."
            items={cropStages}
          />
          {/* ---- end living details (additive) ---- */}
          {/* ---- living details II (additive) ---- */}
          <Row
            title={`Growth stages (${growthStages.length})`}
            note="Two more props that are not a single sprite. Hay is cut between 15:12 and 16:36 and takes an hour to go from a heap to a poled rick, and a farming town grows another one to three of them round each field through the afternoon on top. A timber yard's height is the FRACTION of the wood within ten tiles of it that has actually come down at t, so it fills as its own axes finish — no new event, no new snapshot state, just a count of the chop-dones the day already records. Both families share a pool index with the middle age, so a yard or a rick keeps its identity as it grows."
            items={growthStages}
          />
          {/* ---- end living details II (additive) ---- */}
          <Row
            title={`Treasure (${TREASURE_POOLS.length} states)`}
            note="Pooled, but never a PropSpec: chests are their own list on the map. The timeline walks a found chest along all three — mound, prised open, emptied."
            items={treasure}
          />
          <Row title={`Seeded extras (${EXTRA_PROPS.length})`} items={extras} />
          {/* ---- market day and the festival: dressing with no PropSpec ---- */}
          <Row
            title={`Occasions (${occasions.length})`}
            note="Neither a pool nor a PropSpec: daytype.ts decides where a market day's stalls stand and where the festival's fire is lit, and scene.ts bakes them per site. A stall wears its town's accent on the awning and carries two things off the FESTIVE palette; a string of bunting is baked per SPAN, because the sag belongs to the whole line — a short run between two cottages barely dips and one across a square hangs like a washing line. The bonfire is a woodpile until the flames go on over it every frame."
            items={occasions}
          />
        </Section>

        <Section
          id="inhabitants"
          title="Inhabitants"
          count={counts.inhabitants}
          blurb="The moving parts, drawn straight into the frame each tick: villagers, freight, the crane hook and the mill wheel. ~8fps here; 60 in the world."
        >
          <Inhabitants anims={anims} />
        </Section>

        <Section
          id="wildlife"
          title="Wildlife"
          count={counts.wildlife}
          blurb="Everything alive that nobody built. Deer work the treeline at either end of the day, the flock drifts and grazes, a dog trots the green, birds cross the wood and perch on finished ridges, horses hold a paddock and cattle a pasture, ducks work the water, a fox crosses one night in three, a fish clears the river and leaves a ring, and the fireflies come up over the marsh after dark. Half an hour of eclipse and most of them behave as if it were evening — the hunkered bird is the one variant the dark has art of its own for. Same ~8fps clock as the inhabitants above."
        >
          <Inhabitants anims={wildlife} />
        </Section>

        {/* ---- boats, the ferry and the two rare rivers (additive) ---- */}
        <Section
          id="water"
          title="Water"
          count={counts.water}
          blurb="What the valley does with its river. The moods are presentation only — flood and drought repaint the water and move nothing, so a bridge, a pier and a gravel bar are in the same place on all three days and every archived river is identical to the byte."
        >
          <Row
            title={`The river, three ways (${rivers.length})`}
            note="One reach of one river through bakeRiver(), the ground bake's own river block. riverMood() is the entire world-visible mechanism of the two rare days: three multipliers, (1, 1, 1) on every other day there has ever been. The drought's trick is that the CHANNEL does not move — the exposed bed only exists because the banks stay where they were — and its stones are drawn dark with a lit top and a shadow pixel, because pale grey on pale sand disappears."
            items={rivers}
          />
          <Row
            title={`Flood wreckage (${flotsam.length})`}
            note="Eight pieces ride a flood, wrapping round the river's arclength at a brisk walk. Downstream is worked out rather than stored: isoY is monotone in (gx + gy), so the end further down the screen is the end the water is going to. Small on purpose — a plank the size of a cart reads as a boat, and a boat on a flood is a different story."
            items={flotsam}
          />
          <Row
            title={`The ferry (${ferry.length})`}
            note={`On about 29% of seeds, a reach of river that runs at least ${13} tiles from any crossing gets a ferry: two landing stages facing each other and a punt working between them all day. It carries no road — the crossing pass is closed and the roads declined to cross here — so it is terrain, drawn from its own generator substream. A landing is buildJetty at FERRY_LEN (${FERRY_LEN}), a good deal shorter than a town's pier, and the punt is deliberately not a rowboat: a rowboat is a curve with a bow, a punt is a rectangle with a ramp at each end, and at this size that is the whole difference between somebody's boat and the crossing.`}
            items={ferry}
          />
        </Section>
        {/* ---- end boats, the ferry and the two rare rivers (additive) ---- */}

        <Section
          id="infrastructure"
          title="Infrastructure"
          count={counts.infra}
          blurb="Bridges by stage, one sample of each road kind over meadow, and the biome tints the ground bake blends between."
        >
          <Row title="Crossings" items={bridges} />
          <Row title="Roads" note="Verge, edge, carriageway, centre — a highway alone gets the pale crown." items={roads} />
          <Row title="Biome ground" items={grounds} />
        </Section>

        <Section
          id="terrain"
          title="Terrain"
          count={counts.terrain}
          blurb="The parts of the ground bake that are not a flat tint: standing water, bare rock showing through, whatever somebody stood on end on the moor four thousand years ago, and what the month does to the leaves."
        >
          <Row
            title="Lakes"
            note="sampleLake() off the generator's own shape machinery, laid down by the renderer's bakeLake(): six blobs on one stored outline scaled about its centre, then foam on the shore and a couple of flat glints, both seeded off the lake so they never crawl."
            items={lakes}
          />
          <Row
            title="Outcrop ground"
            note="outcropTint() — the biome tint pulled towards bare stone under every outcrop, so a quarry reads as exposed rock rather than as a tidy pile of stones on a lawn."
            items={outcrops}
          />
          {/* ---- ruins (never catalogued until now) ---- */}
          <Row
            title={`Ruins (${ruins.length})`}
            note="Whoever was here before. A ruin is map data with neither a PropSpec nor a pool — one bake per RuinSpec — and `standing` is how much of the old wall height is still up: below about sixteen pixels a wall stops reading as a wall and turns into a platform, so that is the floor. A corner is two faces meeting at the front quoin; a tower is measured the way buildStructure builds one, shaft and all, so 40% of a tower is a lot more stone than 40% of a hall. One ruin a day is the GHOST — kind, size and place are a pure function of YESTERDAY's seed, and it is the only thread between two days of the valley."
            items={ruins}
          />
          {/* ---- end ruins ---- */}
          {/* ---- standing stones (additive) ---- */}
          <Row
            title={`Standing stones (${monuments.length} kinds)`}
            note="buildStones() — the one thing in the valley older than the ruins, and the only terrain that can name a town. About two seeds in five raise a monument, and only ever on a moor chunk, so a valley with no open moor has no stones at all. A circle keeps one stone down in the heather; a dolmen is the only silhouette with a horizontal in it; a row steps down in height so the eye reads a direction. Nothing here is drawn twice — one to a valley."
            items={monuments}
          />
          {/* ---- end standing stones (additive) ---- */}
          <Row
            title="Seasons"
            note="makePools(season) repaints the six deciduous pools once, at bake, on the finished pixels. Conifers keep their needles; the ground has its own shift, and the woodland beyond the map only half turns."
            items={seasons}
          />
        </Section>

        <section id="palette">
          <h2>
            Palette & tables<span className="count">{counts.palette}</span>
          </h2>
          <p className="blurb">
            The gem accents a site can wear, the light across a day, and the tables gen.ts draws
            roles and woodland from.
          </p>
          <div className="row">
            <h3>Sky ({SKY_DAYS.length})</h3>
            <p className="note">
              skyAt(t, day) applied the way renderGenesis applies it — a multiply fill at{' '}
              <code>a</code> over the valley's green, then the horizon wash at <code>lift</code>.
              The gold hairline along the bottom is <code>lamps</code>: where it shows, windows are
              lit and lamps have their halos.
            </p>
            {SKY_DAYS.map((d) => (
              <div className="skyrow" key={d.key}>
                <div className="skyhead">
                  <b>{d.label}</b>
                  <span>{d.note}</span>
                </div>
                <SkyStrip
                  day={d.day}
                  from={d.mark ? Math.floor(d.mark[0]) - 1 : 0}
                  to={d.mark ? Math.ceil(d.mark[1]) + 1 : 24}
                  hours={
                    d.mark
                      ? [Math.floor(d.mark[0]) - 1, d.mark[0], d.mark[1], Math.ceil(d.mark[1]) + 1]
                      : [0, 4, 8, 12, 16, 20, 24]
                  }
                />
              </div>
            ))}
          </div>
          {/* ---- more day types (additive) ---- */}
          <div className="row">
            <h3>Falling stars</h3>
            <p className="note">
              SCREEN-SPACE, in device pixels, drawn after the fireflies on the finished frame —
              the same layer the aurora is on, and the reason this panel is a slab of valley green
              under the night multiply rather than a sprite. Six lanes on a nine-to-eighteen second
              cycle, each an analytic function of the clock: no state, no reset hook, and a paused
              frame identical to itself. About one star every two seconds, a third of one alight at
              any instant. Each streak is drawn twice — a wide dim bloom under a narrow bright
              trail — because a single hairline of white over a valley that is green under a
              multiply cannot be seen at all.
            </p>
            <StarsPanel />
          </div>
          <div className="row">
            <h3>Day types ({DAY_TYPES.length})</h3>
            <p className="note">
              The lottery a seed draws from, in table order — APPEND-ONLY, because inserting a row
              re-cuts every boundary below it and changes what day an already-archived seed was.
              Two thirds of days are <code>normal</code>. What each one owns in this catalog:
            </p>
            <ul className="daytypes">
              {DAY_TYPES.map((d) => (
                <li key={d}>
                  <b>{d}</b> <span>{DAY_TYPE_ART[d]}</span>
                </li>
              ))}
            </ul>
          </div>
          {/* ---- end more day types (additive) ---- */}
          <div className="row">
            <h3>Accents ({ACCENTS.length})</h3>
            <div className="swatches">
              {ACCENTS.map((hex, i) => (
                <div className="sw" key={hex + i}>
                  <span style={{ background: hex }} />
                  <code>{hex}</code>
                </div>
              ))}
            </div>
          </div>
          <div className="row lists">
            <div>
              <h3>Forest characters ({WOOD_CHARACTER_NAMES.length})</h3>
              <ul>
                {WOOD_CHARACTER_NAMES.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Landmark roles ({LANDMARK_ROLES.length})</h3>
              <ul>
                {LANDMARK_ROLES.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Common roles ({commonCounts.length} of {COMMON_ROLES.length} draws)</h3>
              <ul>
                {commonCounts.map(([r, n]) => (
                  <li key={r}>
                    {r} <em>×{n}</em>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Thatch roles ({THATCH_ROLES.size})</h3>
              <ul>
                {[...THATCH_ROLES].map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <h3>Flavour props ({FLAVOUR_PROPS.length})</h3>
              <ul>
                {FLAVOUR_PROPS.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section id="coverage">
          <h2>
            Coverage notes<span className="count">{COVERAGE.length}</span>
          </h2>
          <p className="blurb">The workbench to-do list: what is thin, what is dead stock.</p>
          <ol className="cov">
            {COVERAGE.map((c) => (
              <li key={c.head}>
                <b>{c.head}</b>
                <span>{c.body}</span>
              </li>
            ))}
          </ol>
        </section>
      </main>
    </div>
  );
}

/* ---------------------------------- style --------------------------------- */

const CSS = `
.cat { --ink:#413a55; --cream:#fdf8ef; --mint:#63c9a8; --line:rgba(65,58,85,.12);
  background:var(--cream); color:var(--ink); min-height:100vh;
  font-family:system-ui,sans-serif; line-height:1.5; }
.cat * { box-sizing:border-box; }
.cat .head { display:flex; align-items:center; justify-content:space-between; gap:1.5rem;
  padding:1.1rem 1.5rem .9rem; }
.cat h1 { font-size:1.15rem; font-weight:700; letter-spacing:-.01em; margin:0; }
.cat .head p { margin:.2rem 0 0; font-size:.82rem; color:rgba(65,58,85,.66); max-width:66ch; }
.cat .night { flex:0 0 auto; font:inherit; font-size:.8rem; cursor:pointer;
  border:1px solid rgba(99,201,168,.55); background:rgba(99,201,168,.14);
  color:#2f9e7d; border-radius:999px; padding:.45rem .95rem; }
.cat .night.on { background:#413a55; border-color:#413a55; color:#f0c75e; }
.cat .nav { position:sticky; top:0; z-index:5; display:flex; flex-wrap:wrap; gap:.4rem;
  padding:.6rem 1.5rem; background:rgba(253,248,239,.94);
  backdrop-filter:blur(6px); border-bottom:1px solid var(--line); }
.cat .nav a { font-size:.78rem; text-decoration:none; color:var(--ink);
  border:1px solid var(--line); border-radius:999px; padding:.25rem .7rem; }
.cat .nav a:hover { background:rgba(99,201,168,.16); border-color:rgba(99,201,168,.5); }
.cat .nav b { font-weight:600; color:#2f9e7d; margin-left:.35rem; }
.cat main { padding:0 1.5rem 5rem; }
.cat section { padding-top:2.2rem; }
.cat h2 { font-size:.92rem; letter-spacing:.12em; text-transform:uppercase;
  margin:0 0 .2rem; display:flex; align-items:center; gap:.55rem; }
.cat .count { font-size:.7rem; letter-spacing:0; background:rgba(99,201,168,.2);
  color:#2f7f68; border-radius:999px; padding:.05rem .5rem; }
.cat .blurb { margin:0 0 .4rem; font-size:.82rem; color:rgba(65,58,85,.66); max-width:78ch; }
.cat .row { margin-top:1rem; }
.cat h3 { font-size:.78rem; font-weight:600; margin:0 0 .1rem; color:rgba(65,58,85,.85); }
.cat .note { margin:0 0 .5rem; font-size:.75rem; color:rgba(65,58,85,.55); }
.cat .grid { display:flex; flex-wrap:wrap; gap:.5rem; align-items:flex-end; }
.cat .cell { margin:0; background:#fff; border:1px solid var(--line); border-radius:10px;
  padding:.4rem; display:flex; flex-direction:column; gap:.3rem; max-width:100%; }
.cat .art { display:flex; align-items:flex-end; justify-content:center;
  background:linear-gradient(180deg,#eef7f0,#e4f1e8); border-radius:6px; padding:.35rem;
  overflow:auto; }
.cat.night .art { background:linear-gradient(180deg,#2a2c3f,#1e2030); }
.cat .pix { image-rendering:pixelated; display:block; max-width:100%; height:auto; }
.cat figcaption { display:flex; flex-wrap:wrap; align-items:baseline; gap:.3rem;
  font-size:.72rem; max-width:15rem; }
.cat .name { font-weight:600; }
.cat .sub { color:rgba(65,58,85,.5); font-size:.68rem; }
.cat .tag { font-size:.6rem; letter-spacing:.06em; text-transform:uppercase;
  border-radius:999px; padding:.02rem .38rem; }
.cat .tag.generic { background:rgba(240,199,94,.28); color:#8a6b1c; }
.cat .tag.unused { background:rgba(239,127,147,.22); color:#a83f55; }
.cat .tag.info { background:rgba(108,196,217,.24); color:#256f85; }
.cat .skyrow { margin:.5rem 0 .9rem; max-width:480px; }
.cat .skyhead { display:flex; flex-wrap:wrap; align-items:baseline; gap:.4rem;
  font-size:.72rem; margin-bottom:.2rem; }
.cat .skyhead b { font-weight:600; }
.cat .skyhead span { color:rgba(65,58,85,.55); }
.cat .sky { position:relative; }
.cat .sky canvas { display:block; width:100%; height:34px; border-radius:5px;
  border:1px solid var(--line); }
.cat .ticks { position:relative; height:1rem; }
.cat .ticks span { position:absolute; transform:translateX(-50%); font-size:.62rem;
  color:rgba(65,58,85,.5); white-space:nowrap; }
.cat .note code { font-size:.72rem; background:rgba(65,58,85,.07); border-radius:3px;
  padding:0 .2rem; }
.cat .starpair { display:flex; flex-wrap:wrap; gap:.8rem; }
.cat .starpair figure { margin:0; max-width:420px; }
.cat .starpair figcaption { font-size:.7rem; color:rgba(65,58,85,.55); margin-top:.25rem; }
.cat .stars { display:block; width:100%; max-width:420px; height:auto;
  border-radius:5px; border:1px solid var(--line); }
.cat .daytypes { list-style:none; margin:.3rem 0 0; padding:0; max-width:88ch; }
.cat .daytypes li { font-size:.76rem; margin-bottom:.28rem; }
.cat .daytypes b { font-weight:600; }
.cat .daytypes span { color:rgba(65,58,85,.6); }
.cat .swatches { display:flex; flex-wrap:wrap; gap:.4rem; }
.cat .sw { display:flex; flex-direction:column; gap:.2rem; align-items:center; }
.cat .sw span { width:56px; height:34px; border-radius:6px; border:1px solid var(--line); }
.cat .sw code { font-size:.66rem; color:rgba(65,58,85,.6); }
.cat .lists { display:flex; flex-wrap:wrap; gap:2rem; }
.cat .lists ul { margin:.2rem 0 .8rem; padding-left:1rem; font-size:.78rem;
  color:rgba(65,58,85,.75); }
.cat .lists em { color:rgba(65,58,85,.45); font-style:normal; }
.cat .cov { margin:.6rem 0 0; padding-left:1.1rem; max-width:88ch; }
.cat .cov li { margin-bottom:.55rem; font-size:.82rem; }
.cat .cov b { display:block; }
.cat .cov span { color:rgba(65,58,85,.66); }
`;
