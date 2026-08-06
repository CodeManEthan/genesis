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
  buildNameBoard,
  buildSignpost,
  buildStake,
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
  shade,
  type BotAction,
  type BuildMaterial,
  type Ctx,
  type Sprite,
} from '../vale/art';
import {
  bakeLake,
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
  FLAVOUR_PROPS,
  LANDMARK_ROLES,
  QUARRY_REACH,
  THATCH_ROLES,
  WOOD_CHARACTER_NAMES,
  sampleLake,
} from './gen';
import { PLAIN_DAY, type DayInfo, type Season } from './daytype';
import type { Biome, RoofStyle, StructureRole, TreeKind, Vec2 } from './types';

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
 * (chimney / awning / banner / cupola). See the `role ===` branches in
 * src/components/designs/vale/art.ts (`buildStructure`, "role furniture"):
 * tower, granary, mill, smithy, bakery and brewhouse are the only ones with
 * their own furniture; barn, shed and granary additionally get timber walls
 * (`woody`), and barn alone gets plank seams, a wide door and no ground-floor
 * window on its right face.
 */
const GENERIC_ROLES = new Set<StructureRole>([
  'cottage', 'house', 'hall', 'workshop', 'store', 'chapel', 'homestead',
]);
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
  'fenceR', 'shed', 'cart', 'crates', 'lumber', 'barrels', 'well', 'lamp',
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
const EXTRA_PROPS = ['nameboard', 'signpost', 'stake', 'crane'];

/**
 * What gen.ts actually emits, so the catalog can flag the rest:
 *  - wild scatter  SCATTER_KINDS (gen.ts, "wild scatter"): bush, rock, stump,
 *    flowers, sheep, reeds — plus fenceL/fenceR from the field-fence pass.
 *  - site essentials (gen.ts, site dressing): well, nameboard, lamp, signpost,
 *    campfire, lumber — plus quarry-blocks and crane in the stone yard of any
 *    town that came up within QUARRY_REACH of an outcrop.
 *  - flavour tail: FLAVOUR_PROPS = crop, haystack, crates, barrels, cart, shed.
 * `stake` has a builder and a propSprite case but no generator ever asks for it.
 */
const GENERATED = new Set<string>([
  'bush', 'rock', 'stump', 'flowers', 'sheep', 'reeds', 'fenceL', 'fenceR',
  'well', 'nameboard', 'lamp', 'signpost', 'campfire', 'lumber',
  // The stone yard, emitted with the essentials so it survives every pace.
  'quarry-blocks', 'crane',
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
  c: HTMLCanvasElement;
}

const item = (key: string, label: string, c: HTMLCanvasElement, extra: Partial<Item> = {}): Item =>
  ({ key, label, c: trim(c), ...extra });

/** Blit one baked sprite at ×3, pixels hard. */
function Pix({ c }: { c: HTMLCanvasElement }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.width = c.width * SCALE;
    el.height = c.height * SCALE;
    const g = el.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, el.width, el.height);
    g.drawImage(c, 0, 0, c.width, c.height, 0, 0, el.width, el.height);
  }, [c]);
  return <canvas ref={ref} className="pix" />;
}

function Cell({ it }: { it: Item }) {
  return (
    <figure className="cell">
      <div className="art">
        <Pix c={it.c} />
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
  workshop: { w: 36, floors: 1, roof: 'gable', awning: true },
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

function bridgeCanvas(stage: 1 | 2 | 3): HTMLCanvasElement {
  // A straight reach of river running along +gx/+gy, so the deck crosses it
  // left-to-right on screen.
  const river: Vec2[] = [
    [-5, -5],
    [5, 5],
  ];
  return bake(150, 66, 75, 40, (ctx) => {
    drawBridge(ctx, river, 0, 0, 4, stage);
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
    strip(ctx, river, 0.95 + 0.75, PAL.sand);
    strip(ctx, river, 0.95, PAL.waterDeep);
    strip(ctx, river, 0.95 * 0.76, PAL.water);
    strip(ctx, river, 0.95 * 0.34, PAL.waterLight);
    paintRoad(ctx, road, 'track', 0.4, 2024);
    drawFord(ctx, river, 0, 0, 3.4);
  });
}

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
    head: '7 of 16 roles share the plain-house art',
    body:
      'cottage, house, hall, workshop, store, chapel and homestead all fall through to the same box; only size, roof and the spec flags (chimney / awning / banner / cupola) tell them apart. shed differs from a house by timber walls alone. Distinct furniture exists for tower, granary, mill, smithy, bakery, brewhouse, gildhall — and barn (plank seams, wide door).',
  },
  {
    head: 'homestead is the founding house and looks like any other house',
    body:
      'It is the one building the day opens on and the one every visitor sees first. Worth a porch, a woodpile or a washing line of its own — and a quarry town has no stone-specific homestead either, so the first house of a stone valley is the same box in masonry.',
  },
  {
    head: 'Stone stops at the walls',
    body:
      'material: "stone" reaches coursed walls, quoins, lintels and a slate roof, and nothing else. A quarry town’s well, lamps, fences and signpost are the same timber-and-render props a meadow town puts up, and there is no drystone wall or stone bridge anywhere in the set.',
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
    head: 'Nothing uses the water',
    body:
      'Lakes and river carry fish, ripples and foam, and not one thing anybody built: no boat, no jetty, no moored punt, no ford besides the bridge. A lake is scenery a town happens to stand next to rather than something it works.',
  },
  {
    head: 'The wildlife is four animals and no predators',
    body:
      'deer, dog, grazing sheep, bird — plus fireflies and a fish. No horse on the highway, no cattle in the farm biome, nothing that hunts and nothing anyone owns. Birds also never perch: they fly a line and fade.',
  },
  {
    head: 'The season repaints leaves and grass, and stops there',
    body:
      'seasonCanvas runs over the six DECIDUOUS pools and the ground tint. crop, haystack, reeds and flowers are summer art in every month, so a winter valley still has a green cornfield in it.',
  },
  {
    head: 'Trees have two states and a nudge',
    body:
      'standing / stump, with felling drawn as the standing sprite shoved ±2px. No half-fallen trunk, no felled log on the ground, no sapling.',
  },
  {
    head: 'Props are one sprite each',
    body:
      'crop never ripens, haystack never shrinks, crates never stack higher as a town grows. Progress is expressed by buildings alone.',
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
    return out;
  }, []);

  const anims = useMemo<Anim[]>(() => {
    const actions: BotAction[] = ['walk', 'carry', 'work', 'idle'];
    const list: Anim[] = actions.map((a, i) => ({
      key: `bot-${a}`,
      label: `bot · ${a}`,
      sub: 'drawBot',
      w: 18,
      h: 24,
      ox: 9,
      oy: 21,
      draw: (ctx, t) => drawBot(ctx, 0, 0, ['#ef7f93', '#63c9a8', '#9b8fe8', '#6cc4d9'][i], true, a, t),
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
    return list;
  }, []);

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
        // What the lightest road class does instead. No stages: it is terrain
        // plus footfall, and it looks like this from midnight onwards.
        item('fd-0', 'ford', fordCanvas(), { sub: 'tracks only · no build stages' }),
      ],
    []
  );

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

  const commonCounts = useMemo(() => {
    const m = new Map<StructureRole, number>();
    for (const r of COMMON_ROLES) m.set(r, (m.get(r) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, []);

  const counts = {
    structures: structures.length + materials.length + stages.length + roofs.length,
    trees: trees.length + treeStates.length,
    props: props.length + treasure.length + extras.length,
    inhabitants: anims.length,
    wildlife: wildlife.length,
    infra: bridges.length + roads.length + grounds.length,
    terrain: lakes.length + outcrops.length + seasons.length,
    palette: ACCENTS.length + SKY_DAYS.length,
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
            note={`${GENERIC_ROLES.size} of ${ROLES.length} draw the plain house. A gildhall is never drawn from the common or landmark bags — it takes a charter out of a buried chest.`}
            items={structures}
          />
          <Row
            title="Materials"
            note={`spec.material — absent is 'timber'. Every plot of a town that came up within QUARRY_REACH (${QUARRY_REACH} u/v units) of an outcrop is 'stone': coursed walls with staggered joints, quoins alternating at the corner, dressed lintels over the openings, and a roof of slate mixed from the town's own accent. gen.ts short-circuits the thatch roll on stone, so no combination of seeds produces a thatched masonry cottage.`}
            items={materials}
          />
          <Row title="Progress stages" note="Shared by every role — shown on a house." items={stages} />
          <Row title="Roof styles" items={roofs} />
        </Section>

        <Section
          id="trees"
          title="Trees"
          count={counts.trees}
          blurb="buildTree(kind, seed) — seven kinds, four seeds each, plus the two states a tree can be caught in."
        >
          <Row title={`Kinds (${TREE_KINDS.length})`} items={trees} />
          <Row
            title="States"
            note="A tree under the axe is the standing sprite offset ±2px; once felled it is replaced by a stump."
            items={treeStates}
          />
        </Section>

        <Section
          id="props"
          title="Props & scatter"
          count={counts.props}
          blurb="Every pooled kind from makePools(), all pool variants, plus the four built on demand by propSprite(). “unused” means gen.ts never emits it."
        >
          <Row title={`Pools (${PROP_POOLS.length} kinds)`} items={props} />
          <Row
            title={`Treasure (${TREASURE_POOLS.length} states)`}
            note="Pooled, but never a PropSpec: chests are their own list on the map. The timeline walks a found chest along all three — mound, prised open, emptied."
            items={treasure}
          />
          <Row title={`Seeded extras (${EXTRA_PROPS.length})`} items={extras} />
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
          blurb="Everything alive that nobody built. Deer work the treeline at either end of the day, the flock drifts and grazes, a dog trots the green, birds cross the wood, a fish clears the river and leaves a ring, and the fireflies come up over the marsh after dark. Same ~8fps clock as the inhabitants above."
        >
          <Inhabitants anims={wildlife} />
        </Section>

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
          blurb="The parts of the ground bake that are not a flat tint: standing water, bare rock showing through, and what the month does to the leaves."
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
