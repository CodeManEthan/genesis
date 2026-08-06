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
  buildCrane,
  buildNameBoard,
  buildSignpost,
  buildStake,
  buildStructure,
  buildStump,
  buildTree,
  drawBot,
  drawCart,
  drawCraneLoad,
  drawWheel,
  isoTile,
  shade,
  type BotAction,
  type Ctx,
  type Sprite,
} from '../vale/art';
import { drawBridge, makePools, paintRoad } from './scene';
import {
  ACCENTS,
  COMMON_ROLES,
  FLAVOUR_PROPS,
  LANDMARK_ROLES,
  THATCH_ROLES,
  WOOD_CHARACTER_NAMES,
} from './gen';
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
  // Buried treasure. Never a PropSpec — chests are their own list on the map —
  // but pooled all the same, so they belong on this shelf.
  'chest-buried', 'chest-closed', 'chest-open',
];

/** Kinds not in the pools — built on demand by `propSprite()` in scene.ts. */
const EXTRA_PROPS = ['nameboard', 'signpost', 'stake', 'crane'];

/**
 * What gen.ts actually emits, so the catalog can flag the rest:
 *  - wild scatter  SCATTER_KINDS (gen.ts, "wild scatter"): bush, rock, stump,
 *    flowers, sheep, reeds — plus fenceL/fenceR from the field-fence pass.
 *  - site essentials (gen.ts, site dressing): well, nameboard, lamp, signpost,
 *    campfire, lumber.
 *  - flavour tail: FLAVOUR_PROPS = crop, haystack, crates, barrels, cart, shed.
 * `crane` is never a PropSpec: scene.ts conjures one in the yard of any
 * landmark-sized plot still going up. `stake` has a builder and a propSprite
 * case but no generator ever asks for it.
 */
const GENERATED = new Set<string>([
  'bush', 'rock', 'stump', 'flowers', 'sheep', 'reeds', 'fenceL', 'fenceR',
  'well', 'nameboard', 'lamp', 'signpost', 'campfire', 'lumber',
  // The three states of a buried chest. gen.ts emits 0..2 ChestSpecs a day and
  // the timeline moves them between these sprites.
  'chest-buried', 'chest-closed', 'chest-open',
  ...FLAVOUR_PROPS,
]);
const SCENE_ONLY = new Set<string>(['crane']);

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
  roof?: RoofStyle
): HTMLCanvasElement {
  const sp = buildStructure({
    role,
    accent,
    w: spec.w,
    floors: spec.floors,
    roof: roof ?? spec.roof,
    progress,
    condition: 1,
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
    head: '7 of 15 roles share the plain-house art',
    body:
      'cottage, house, hall, workshop, store, chapel and homestead all fall through to the same box; only size, roof and the spec flags (chimney / awning / banner / cupola) tell them apart. shed differs from a house by timber walls alone. Distinct furniture exists for tower, granary, mill, smithy, bakery, brewhouse — and barn (plank seams, wide door).',
  },
  {
    head: 'homestead is the founding house and looks like any other house',
    body:
      'It is the one building the day opens on and the one every visitor sees first. Worth a porch, a woodpile or a washing line of its own.',
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
    head: 'Only one animal, and it never moves',
    body:
      'buildSheep is the whole fauna: no birds, no dogs, no horse on the highway. Sheep are static scatter — a flock that drifted a pixel or two would carry the meadow.',
  },
  {
    head: 'No water life and no weather',
    body:
      'The river gets foam flecks and nothing else — no boat, no jetty, no ford crossing besides the bridge. Nothing in the catalog reacts to rain, wind or season.',
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
            tag: GENERIC_ROLES.has(role) ? 'generic' : WOODY_ONLY.has(role) ? 'walls only' : undefined,
            tagKind: GENERIC_ROLES.has(role) ? 'generic' : 'info',
          }
        )
      ),
    [night]
  );

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

  const props = useMemo(() => {
    const out: Item[] = [];
    for (const kind of PROP_POOLS) {
      const p = pools[kind] ?? [];
      p.forEach((sp, i) =>
        out.push(
          item(`pp-${kind}-${i}`, kind, spriteCanvas(sp), {
            sub: p.length > 1 ? `${i + 1}/${p.length}` : undefined,
            tag: GENERATED.has(kind) ? undefined : 'unused',
            tagKind: 'unused',
          })
        )
      );
    }
    return out;
  }, [pools]);

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
        tag: SCENE_ONLY.has('crane') ? 'scene-only' : undefined,
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

  const bridges = useMemo(
    () =>
      ([1, 2, 3] as const).map((s) =>
        item(`br-${s}`, `bridge stage ${s}`, bridgeCanvas(s), {
          sub: s === 1 ? 'pilings' : s === 2 ? 'deck' : 'rails / done',
        })
      ),
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

  const commonCounts = useMemo(() => {
    const m = new Map<StructureRole, number>();
    for (const r of COMMON_ROLES) m.set(r, (m.get(r) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, []);

  const counts = {
    structures: structures.length + stages.length + roofs.length,
    trees: trees.length + treeStates.length,
    props: props.length + extras.length,
    inhabitants: anims.length,
    infra: bridges.length + roads.length + grounds.length,
    palette: ACCENTS.length,
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
        <a href="#infrastructure">Infrastructure <b>{counts.infra}</b></a>
        <a href="#palette">Palette <b>{counts.palette}</b></a>
        <a href="#coverage">Coverage <b>{COVERAGE.length}</b></a>
      </nav>

      <main>
        <Section
          id="structures"
          title="Structures"
          count={counts.structures}
          blurb="buildStructure(spec) — one specimen per StructureRole, then the universal progress ladder and the roof styles. A “generic” tag means the role has no special-case art of its own."
        >
          <Row
            title={`Roles (${ROLES.length})`}
            note={`${GENERIC_ROLES.size} of ${ROLES.length} draw the plain house.`}
            items={structures}
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
          id="infrastructure"
          title="Infrastructure"
          count={counts.infra}
          blurb="Bridges by stage, one sample of each road kind over meadow, and the biome tints the ground bake blends between."
        >
          <Row title="Bridges" items={bridges} />
          <Row title="Roads" note="Verge, edge, carriageway, centre — a highway alone gets the pale crown." items={roads} />
          <Row title="Biome ground" items={grounds} />
        </Section>

        <section id="palette">
          <h2>
            Palette & tables<span className="count">{ACCENTS.length}</span>
          </h2>
          <p className="blurb">
            The gem accents a site can wear, and the tables gen.ts draws roles and woodland from.
          </p>
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
