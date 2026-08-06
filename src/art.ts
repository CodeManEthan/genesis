/**
 * The Vale — pixel rasteriser and sprite factories.
 *
 * Every routine here paints into a *world-resolution* buffer where one unit is
 * one art pixel. The camera blits that buffer to the screen at an integer
 * magnification with `imageSmoothingEnabled = false`, so nothing below may use
 * `arc`, `stroke` or a gradient: filled shapes go through `poly()`, a scanline
 * rasteriser that snaps every span to whole pixels, which is what keeps the 2:1
 * isometric edges as hard stair-steps instead of a grey fringe.
 *
 * Static art is baked once into small offscreen canvases ("sprites") and, for
 * the countryside, pooled — a hundred oaks share six canvases.
 *
 * This module is the only one in the design that touches the DOM. World *data*
 * lives in `worldstate.ts` and is deliberately renderer-free.
 */

export type Ctx = CanvasRenderingContext2D;
export type Pt = [number, number];

/** Isometric tile footprint, in art pixels. The 2:1 ratio gives clean slopes. */
export const TW = 32;
export const TH = 16;
/** Height of one building storey, in art pixels. */
export const STORY = 12;

export interface Sprite {
  c: HTMLCanvasElement;
  /** Anchor offset: the sprite's ground-centre sits at (ox, oy) inside it. */
  ox: number;
  oy: number;
}

/* ------------------------------- palette ------------------------------- */

export const PAL = {
  /* land — one base tint per biome; the renderer blends between them */
  biome: {
    meadow: '#8ed09f',
    forest: '#5fa47e',
    farm: '#a9cf86',
    wetland: '#7cc9ab',
    moor: '#a7b98f',
  } as Record<string, string>,
  grassEdge: '#66ab7d',
  moss: '#5fa87c',

  dirt: '#d6ac7d',
  dirtAlt: '#cda172',
  dirtPale: '#e0b98c',
  dirtEdge: '#b98b5f',

  till: '#c9a274',
  tillDark: '#b1885c',

  water: '#6fb8d6',
  waterDeep: '#4d99bb',
  waterLight: '#95d3e6',
  waterFoam: '#cdeef7',
  sand: '#e2cda0',

  /* structures */
  wall: '#fdf3e2',
  wallShade: '#e6d3b7',
  wallDark: '#cdb694',
  stone: '#cec7ba',
  stoneDark: '#a49d90',
  stoneLight: '#e2ddd2',
  /* dressed masonry — a quarry town's walls. Deliberately cooler and a good
     two steps darker than `wall`, because the whole job of the material is to
     be legible against a cream town from the fitted overview. */
  masonry: '#c2bfb6',
  masonryShade: '#9d9990',
  /* the grey the slate roofs of a stone town are pulled towards */
  slate: '#69717f',
  wood: '#b3855b',
  woodDark: '#8a6340',
  woodLight: '#d8b688',
  thatch: '#d9b263',

  glass: '#a5dcef',
  glassDark: '#7fc2da',
  glassLit: '#ffd98a',
  forge: '#ff9a4d',

  ink: '#413a55',
  shadow: 'rgba(65, 58, 85, 0.18)',
  shadowSoft: 'rgba(65, 58, 85, 0.10)',

  leaf: ['#57bd97', '#48ac86', '#6fcfa8', '#3f9d79'],
  leafDark: '#3a8f6f',
  leafAut: ['#e0a35a', '#d98b4c', '#c9743f'],
  blossom: '#f2a8c0',

  flower: ['#ef7f93', '#f0c75e', '#ffffff', '#9b8fe8', '#6cc4d9'],
  crop: ['#5fc4a1', '#8fcf6a', '#d9c05e'],

  chalk: '#f4efe2',
} as const;

/* ------------------------------ utilities ------------------------------ */

/** Deterministic PRNG — the vale must look identical on every load. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lighten (amt > 0) or darken (amt < 0) a hex colour. */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  if (amt >= 0) {
    r += (255 - r) * amt;
    g += (255 - g) * amt;
    b += (255 - b) * amt;
  } else {
    const k = 1 + amt;
    r *= k;
    g *= k;
    b *= k;
  }
  const v = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  return `#${(v | 0x1000000).toString(16).slice(1)}`;
}

export function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (sh: number) => Math.round((((pa >> sh) & 255) * (1 - t) + ((pb >> sh) & 255) * t));
  const v = (ch(16) << 16) | (ch(8) << 8) | ch(0);
  return `#${(v | 0x1000000).toString(16).slice(1)}`;
}

export function rect(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/** Scanline polygon fill with whole-pixel spans — the workhorse. */
export function poly(ctx: Ctx, pts: Pt[], color: string): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  if (!isFinite(minY)) return;
  ctx.fillStyle = color;
  const xs: number[] = [];
  const y0 = Math.floor(minY);
  const y1 = Math.ceil(maxY);
  for (let y = y0; y < y1; y++) {
    const sy = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if ((a[1] <= sy && b[1] > sy) || (b[1] <= sy && a[1] > sy)) {
        xs.push(a[0] + ((sy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.round(xs[i]);
      const xb = Math.round(xs[i + 1]);
      if (xb > xa) ctx.fillRect(xa, y, xb - xa, 1);
    }
  }
}

/** An isometric ground tile centred on (cx, cy). Hand-unrolled for speed. */
export function isoTile(ctx: Ctx, cx: number, cy: number, color: string): void {
  ctx.fillStyle = color;
  const left = cx - 16;
  const top = cy - 8;
  for (let i = 0; i < 16; i++) {
    const w = i < 8 ? 4 * (i + 1) : 4 * (16 - i);
    ctx.fillRect(left + (32 - w) / 2, top + i, w, 1);
  }
}

/** Corner points of a diamond of on-screen width `w`, centred at (cx, cy). */
export function diamond(cx: number, cy: number, w: number): Pt[] {
  const h = w / 2;
  return [
    [cx, cy - h / 2],
    [cx + w / 2, cy],
    [cx, cy + h / 2],
    [cx - w / 2, cy],
  ];
}

export function makeSprite(
  w: number,
  h: number,
  ox: number,
  oy: number,
  draw: (ctx: Ctx) => void
): Sprite {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const rx = Math.round(ox);
  const ry = Math.round(oy);
  ctx.translate(rx, ry);
  draw(ctx);
  return { c, ox: rx, oy: ry };
}

/** Rounded pixel blob: `widths` are per-row widths, top row first. */
function blob(ctx: Ctx, cx: number, cy: number, widths: number[], color: string): void {
  ctx.fillStyle = color;
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i];
    if (w <= 0) continue;
    ctx.fillRect(Math.round(cx - w / 2), Math.round(cy + i), Math.round(w), 1);
  }
}

/* ------------------------------ structures ------------------------------ */

export type RoofStyle = 'hip' | 'gable' | 'flat' | 'thatch';

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
  // Genesis-only roles. Additive: the vale never asks for them, and every
  // routine below falls through to the plain-house path when it sees one.
  | 'bakery'
  | 'brewhouse'
  | 'homestead'
  // Only ever built on a charter dug out of a buried chest, so it is allowed a
  // silhouette no ordinary plot can have: gilded ridge, gilded eaves, a lamp on
  // the ridge end and a plaque by the door.
  | 'gildhall';

/**
 * What the walls are made of. Additive and optional: absent means 'timber',
 * which is the render-and-frame cream wall every caller drew before quarry
 * towns existed, so the vale is untouched by this.
 */
export type BuildMaterial = 'timber' | 'stone';

export interface StructureSpec {
  role: StructureRole;
  accent: string;
  /** Footprint width on screen, in art pixels. Rounded to a multiple of 4. */
  w: number;
  floors: number;
  roof: RoofStyle;
  /** 0 → surveyed plot, 1 → finished. Everything between is a build stage. */
  progress: number;
  /** 0 → derelict, 1 → freshly painted. Weathers the roof and walls. */
  condition: number;
  chimney?: boolean;
  cupola?: boolean;
  antenna?: boolean;
  awning?: boolean;
  banner?: boolean;
  lit?: boolean;
  /** Absent === 'timber'. 'stone' gives coursed masonry walls and slate. */
  material?: BuildMaterial;
  seed: number;
}

export interface StructureSprite extends Sprite {
  /** Chimney mouth, relative to the ground-centre anchor. */
  smoke: Pt | null;
  /** Watermill wheel hub, relative to the ground-centre anchor. */
  wheel: Pt | null;
}

/* Face parameterisation: t runs corner→corner, hh is height above ground. */
function leftPt(W: number, t: number, hh: number): Pt {
  return [-W / 2 + (t * W) / 2, (t * W) / 4 - hh];
}
function rightPt(W: number, t: number, hh: number): Pt {
  return [(t * W) / 2, W / 4 - (t * W) / 4 - hh];
}
function qL(W: number, t0: number, t1: number, h0: number, h1: number): Pt[] {
  return [leftPt(W, t0, h1), leftPt(W, t1, h1), leftPt(W, t1, h0), leftPt(W, t0, h0)];
}
function qR(W: number, t0: number, t1: number, h0: number, h1: number): Pt[] {
  return [rightPt(W, t0, h1), rightPt(W, t1, h1), rightPt(W, t1, h0), rightPt(W, t0, h0)];
}

function drawWindow(
  ctx: Ctx,
  W: number,
  side: 'l' | 'r',
  tc: number,
  hc: number,
  lit: boolean,
  /** When set, a dressed stone lintel over the head and a sill under the
   * cill, in this colour. Absent leaves the timber-framed window untouched. */
  lintel?: string
): void {
  const q = side === 'l' ? qL : qR;
  const dt = 6 / W;
  poly(ctx, q(W, tc - dt, tc + dt, hc - 3.5, hc + 3.5), PAL.woodDark);
  const inner = q(W, tc - dt * 0.68, tc + dt * 0.68, hc - 2.6, hc + 2.6);
  poly(ctx, inner, lit ? PAL.glassLit : side === 'l' ? PAL.glass : PAL.glassDark);
  const glint = q(W, tc - dt * 0.68, tc - dt * 0.08, hc + 0.5, hc + 2.6);
  poly(ctx, glint, lit ? shade(PAL.glassLit, 0.35) : shade(PAL.glass, 0.4));
  if (lintel) {
    poly(ctx, q(W, tc - dt * 1.45, tc + dt * 1.45, hc + 3.5, hc + 5.4), lintel);
    poly(ctx, q(W, tc - dt * 1.3, tc + dt * 1.3, hc - 5.1, hc - 3.5), shade(lintel, -0.14));
  }
}

/**
 * Coursed masonry over a wall face pair: a mortar seam every course, vertical
 * joints staggered half a block from one course to the next, and quoins
 * alternating up the near corner.
 *
 * The seams are what make it read as stone at zoom 2+; the wall colour alone is
 * what makes it read as stone from the fitted overview, where a one-pixel seam
 * is not there at all. Both matter, and they are doing different jobs.
 */
function drawCourses(ctx: Ctx, W: number, h0: number, h1: number, wl: string, wr: string): void {
  const COURSE = 4.2;
  const seamL = shade(wl, -0.17);
  const seamR = shade(wr, -0.17);
  const quoinL = shade(wl, 0.15);
  const quoinR = shade(wr, 0.15);
  /** One block, in face-parameter units. */
  const BLOCK = 9 / W;
  const JOINT = 1.2 / W;
  let row = 0;
  for (let hh = h0; hh < h1 - 0.6; hh += COURSE, row++) {
    const top = Math.min(h1, hh + COURSE);
    // vertical joints, offset half a block on alternate courses
    const off = row & 1 ? BLOCK * 0.5 : 0;
    for (let t = off + BLOCK; t < 1 - JOINT; t += BLOCK) {
      poly(ctx, qL(W, t - JOINT, t + JOINT, hh, top), seamL);
      poly(ctx, qR(W, t - JOINT, t + JOINT, hh, top), seamR);
    }
    // the bed joint on top of the course
    if (top < h1 - 0.4) {
      poly(ctx, qL(W, 0, 1, top - 0.5, top + 0.5), seamL);
      poly(ctx, qR(W, 0, 1, top - 0.5, top + 0.5), seamR);
    }
    // quoins: a long stone alternating which face it presents at the corner
    const dq = 5.5 / W;
    if (row & 1) poly(ctx, qL(W, 1 - dq, 1, hh + 0.6, top - 0.6), quoinL);
    else poly(ctx, qR(W, 0, dq, hh + 0.6, top - 0.6), quoinR);
  }
}

/** Stacked-box scaffolding drawn against the front-left face. */
function drawScaffold(ctx: Ctx, W: number, h: number): void {
  const lifts = Math.max(2, Math.round(h / 11));
  for (let i = 1; i <= lifts; i++) {
    const hh = (h / lifts) * i;
    // Each lift is a plank with its own shadow line: against a cream wall a
    // single pale band all but disappears.
    poly(ctx, qL(W, 0.05, 0.95, hh - 2.1, hh - 1.3), PAL.woodDark);
    poly(ctx, qL(W, 0.05, 0.95, hh - 1.3, hh + 1.3), PAL.woodLight);
  }
  for (const t of [0.08, 0.5, 0.92]) {
    poly(ctx, qL(W, t - 1.2 / W, t + 1.2 / W, 0, h + 3), PAL.wood);
  }
  const a = leftPt(W, 0.1, 1);
  const b = leftPt(W, 0.9, h);
  poly(ctx, [a, [a[0] + 1.5, a[1] + 1], [b[0] + 1.5, b[1] + 1], b], PAL.woodDark);
}

/** Roof geometry shared by the finished and half-built passes. */
function drawRoof(
  ctx: Ctx,
  W: number,
  wallH: number,
  style: RoofStyle,
  accent: string,
  condition: number,
  /** 'stone' pulls the roof towards slate. Absent behaves as 'timber'. */
  material?: BuildMaterial
): number {
  const eave = 4;
  const RW = W + eave * 2;
  const ry = -wallH;
  // A stone town roofs in slate — but slate mixed *from* the town's own accent,
  // so the greys still differ town to town and the ledger colour still reads.
  const base =
    style === 'thatch'
      ? PAL.thatch
      : material === 'stone'
        ? mix(accent, PAL.slate, 0.66)
        : accent;
  const col = mix(base, '#8d9a86', (1 - condition) * 0.45);
  const dark = shade(col, -0.3);
  const mid = shade(col, -0.14);
  const light = shade(col, 0.22);
  const roofH = style === 'flat' ? 5 : Math.round(W * (style === 'thatch' ? 0.34 : 0.3));

  if (style === 'flat') {
    poly(ctx, qL(W, 0, 1, wallH, wallH + 5), mid);
    poly(ctx, qR(W, 0, 1, wallH, wallH + 5), dark);
    poly(ctx, diamond(0, ry - 5, W), light);
    poly(ctx, diamond(0, ry - 3, W - 12), '#8e8aa0');
    const tk = -W / 6;
    rect(ctx, tk - 3, ry - 16, 7, 8, PAL.stone);
    rect(ctx, tk - 3, ry - 17, 7, 2, PAL.stoneDark);
    rect(ctx, W / 6, ry - 12, 5, 5, shade(PAL.stone, -0.2));
    return roofH;
  }

  const N: Pt = [0, ry - RW / 4];
  const E: Pt = [RW / 2, ry];
  const S: Pt = [0, ry + RW / 4];
  const Wc: Pt = [-RW / 2, ry];

  if (style === 'hip') {
    const apex: Pt = [0, ry - roofH];
    poly(ctx, [N, Wc, apex], shade(col, -0.42));
    poly(ctx, [N, E, apex], shade(col, -0.36));
    poly(ctx, [Wc, S, apex], col);
    poly(ctx, [S, E, apex], dark);
    poly(ctx, [Wc, S, [S[0], S[1] + 2.4], [Wc[0], Wc[1] + 2.4]], shade(col, -0.5));
    poly(ctx, [S, E, [E[0], E[1] + 2.4], [S[0], S[1] + 2.4]], shade(col, -0.55));
    poly(ctx, [
      [Wc[0] * 0.5, (Wc[1] + apex[1]) / 2],
      apex,
      [apex[0], apex[1] + 2],
      [Wc[0] * 0.5 + 1, (Wc[1] + apex[1]) / 2 + 2],
    ], light);
    return roofH;
  }

  // gable / thatch share a ridge
  const R1: Pt = [-RW / 4, ry - RW / 8 - roofH];
  const R2: Pt = [RW / 4, ry + RW / 8 - roofH];
  poly(ctx, [N, Wc, R1], shade(col, -0.45));
  poly(ctx, [N, E, R2, R1], shade(col, -0.38));
  poly(ctx, [E, S, R2], mid);
  poly(ctx, [Wc, S, R2, R1], col);
  poly(ctx, [Wc, S, [S[0], S[1] + 2.4], [Wc[0], Wc[1] + 2.4]], shade(col, -0.5));
  poly(ctx, [R1, R2, [R2[0], R2[1] + 2], [R1[0], R1[1] + 2]], light);
  if (style === 'thatch') {
    // straw courses: horizontal bands stepping down the near slope
    for (let k = 1; k <= 3; k++) {
      const f = k / 4;
      const a: Pt = [Wc[0] + (R1[0] - Wc[0]) * f, Wc[1] + (R1[1] - Wc[1]) * f];
      const b: Pt = [S[0] + (R2[0] - S[0]) * f, S[1] + (R2[1] - S[1]) * f];
      poly(ctx, [a, b, [b[0], b[1] + 1], [a[0], a[1] + 1]], shade(col, -0.16));
    }
  } else {
    rect(ctx, RW / 4 - 1, ry - roofH + 2, 2, 4, shade(col, -0.55));
  }
  return roofH;
}

/**
 * A building that exists only on paper: a scraped plot, a dashed chalk outline,
 * a dug footing trench and four ribboned survey stakes. This has to read at a
 * glance — it is the whole point of the frontier.
 */
function drawPlot(ctx: Ctx, W: number, accent: string, seed: number): void {
  const rng = mulberry32(seed);
  const RW = W + 6;
  const corners: Pt[] = [
    [0, -RW / 4],
    [RW / 2, 0],
    [0, RW / 4],
    [-RW / 2, 0],
  ];
  // scraped ground
  poly(ctx, diamond(0, 1, RW + 6), shade(PAL.till, -0.06));
  poly(ctx, diamond(0, 0, RW), shade(PAL.till, 0.1));
  // footing trench, one course of stone already laid on two sides
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    poly(ctx, [a, b, [b[0], b[1] + 2.4], [a[0], a[1] + 2.4]], i < 2 ? PAL.tillDark : PAL.stone);
  }
  // dashed chalk line just outside the trench
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const steps = Math.max(5, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
    for (let k = 0; k < steps; k++) {
      if (k % 2) continue;
      const t = k / steps;
      rect(ctx, a[0] + (b[0] - a[0]) * t - 1, a[1] + (b[1] - a[1]) * t - 3, 3, 1, PAL.chalk);
    }
  }
  // survey stakes with ribbons
  for (const c of corners) {
    rect(ctx, c[0] - 0.5, c[1] - 14, 1, 14, PAL.woodLight);
    rect(ctx, c[0] - 1, c[1] - 15, 2, 1, PAL.woodDark);
    poly(ctx, [[c[0] + 0.5, c[1] - 14], [c[0] + 8, c[1] - 11.5], [c[0] + 0.5, c[1] - 9]], accent);
  }
  // a peg or two knocked in where the posts will go
  for (let i = 0; i < 3; i++) {
    const x = (rng() - 0.5) * W * 0.6;
    const y = (rng() - 0.5) * W * 0.3;
    rect(ctx, x, y - 4, 1, 4, PAL.wood);
  }
}

export function buildStructure(spec: StructureSpec): StructureSprite {
  const { role, accent, floors, roof, seed, condition } = spec;
  const rng = mulberry32(seed);
  const W = Math.max(16, Math.round(spec.w / 4) * 4);
  const H = W / 2;
  const p = spec.progress;
  const wallH = floors * STORY;

  const towerH = role === 'tower' ? Math.round(wallH * 0.5) + 16 : 0;
  const siloH = role === 'granary' ? wallH + 12 : 0;
  const sailR = role === 'mill' ? 22 : 0;
  /** Oast-house cone above the brewhouse drum. */
  const kilnH = role === 'brewhouse' ? 26 : 0;

  const padX = 12 + (sailR ? 12 : 0) + (role === 'bakery' ? 8 : 0);
  /** Ridge lamp and finial on a gildhall stand clear of the roof. */
  const gildH = role === 'gildhall' ? 14 : 0;
  const padTop = 34 + towerH + siloH + sailR + kilnH + gildH + (spec.cupola ? 22 : 0);
  const padBottom = 8;
  const spriteW = W + padX * 2;
  const spriteH = padTop + Math.round(W * 0.4) + wallH + H + padBottom + 20;

  let smoke: Pt | null = null;
  let wheel: Pt | null = null;

  const sp = makeSprite(spriteW, spriteH, padX + W / 2, spriteH - H / 2 - padBottom, (ctx) => {
    /* ---- surveyed plot only ---------------------------------------- */
    if (p < 0.12) {
      drawPlot(ctx, W, accent, seed);
      return;
    }

    poly(ctx, diamond(3, 2, W + 6), PAL.shadow);

    /* ---- foundations ------------------------------------------------ */
    const footH = 3;
    poly(ctx, qL(W, 0, 1, 0, footH), PAL.stone);
    poly(ctx, qR(W, 0, 1, 0, footH), PAL.stoneDark);

    if (p < 0.45) {
      // Bare timber frame on a finished footing: posts already stand near their
      // full height, because a frame that only reaches ankle height reads as
      // nothing at all from the road.
      const frameH = Math.round(wallH * (0.62 + ((p - 0.12) / 0.33) * 0.58));
      for (const t of [0.02, 0.34, 0.66, 0.98]) {
        poly(ctx, qL(W, t - 1.6 / W, t + 1.6 / W, footH, frameH), PAL.wood);
        poly(ctx, qR(W, t - 1.6 / W, t + 1.6 / W, footH, frameH), PAL.woodDark);
      }
      poly(ctx, qL(W, 0, 1, frameH - 2.4, frameH), PAL.woodLight);
      poly(ctx, qR(W, 0, 1, frameH - 2.4, frameH), PAL.wood);
      const a = leftPt(W, 0.04, footH);
      const b = leftPt(W, 0.5, frameH - 2);
      poly(ctx, [a, [a[0] + 1.6, a[1] + 1], [b[0] + 1.6, b[1] + 1], b], PAL.woodDark);
      // stake + accent ribbon so the plot still carries the project colour
      rect(ctx, -W / 2 + 1, -frameH - 8, 1, 9, PAL.woodLight);
      poly(ctx, [
        [-W / 2 + 2, -frameH - 8],
        [-W / 2 + 12, -frameH - 5.5],
        [-W / 2 + 2, -frameH - 2],
      ], accent);
      return;
    }

    /* ---- walls ------------------------------------------------------ */
    // Stone rises here and nowhere earlier: the footing and the frame above are
    // the same timber scaffold whatever the building will end up being made of,
    // which is both what a mason's site looks like and what keeps every
    // progress stage working for free.
    const stone = spec.material === 'stone';
    const woody = !stone && (role === 'barn' || role === 'shed' || role === 'granary');
    const baseL = stone ? PAL.masonry : woody ? PAL.woodLight : PAL.wall;
    const baseR = stone ? PAL.masonryShade : woody ? PAL.wood : PAL.wallShade;
    const wl = mix(baseL, '#b9b2a4', (1 - condition) * 0.4);
    const wr = mix(baseR, '#a49d90', (1 - condition) * 0.4);
    const built = p >= 0.62 ? wallH : Math.round(wallH * (0.52 + (p - 0.45) * 2.82));
    poly(ctx, qL(W, 0, 1, footH, built), wl);
    poly(ctx, qR(W, 0, 1, footH, built), wr);
    // Courses go on before the storey bands and the openings, so a floor line
    // or a lintel still reads as a thing laid over the masonry.
    if (stone) drawCourses(ctx, W, footH, built, wl, wr);

    if (role === 'barn' && !stone) {
      // plank seams
      for (let t = 0.12; t < 1; t += 0.16) {
        poly(ctx, qL(W, t, t + 0.012, footH, built), shade(wl, -0.16));
        poly(ctx, qR(W, t, t + 0.012, footH, built), shade(wr, -0.16));
      }
    }
    // Floor line: a string course on stone, a painted band on render.
    const bandL = stone ? shade(wl, -0.3) : PAL.wallDark;
    const bandR = stone ? shade(wr, -0.3) : shade(PAL.wallDark, -0.12);
    for (let f = 1; f < floors; f++) {
      const hh = f * STORY;
      if (hh > built) break;
      poly(ctx, qL(W, 0, 1, hh - 1, hh + 0.6), bandL);
      poly(ctx, qR(W, 0, 1, hh - 1, hh + 0.6), bandR);
    }
    rect(ctx, 0, H / 2 - built, 1, built, shade(wl, 0.1));

    const finished = p >= 0.985;

    // Walls short of plate height show their studwork, and the posts carry on
    // bare above the infill to the height the house will finish at. A part-built
    // house then reads as a timber frame being filled in — and keeps the
    // silhouette of the building it is going to be, instead of squatting in the
    // field as an anonymous cream box a third of its eventual size.
    if (p < 0.62) {
      for (const t of [0.02, 0.34, 0.66, 0.98]) {
        poly(ctx, qL(W, t - 1.4 / W, t + 1.4 / W, footH, built), PAL.wood);
        poly(ctx, qR(W, t - 1.4 / W, t + 1.4 / W, footH, built), PAL.woodDark);
      }
      poly(ctx, qL(W, 0, 1, built * 0.52 - 1, built * 0.52 + 0.8), PAL.wood);
      poly(ctx, qR(W, 0, 1, built * 0.52 - 1, built * 0.52 + 0.8), PAL.woodDark);
      for (const t of [0.02, 0.5, 0.98]) {
        poly(ctx, qL(W, t - 1.4 / W, t + 1.4 / W, built, wallH), PAL.wood);
        poly(ctx, qR(W, t - 1.4 / W, t + 1.4 / W, built, wallH), PAL.woodDark);
      }
    }

    if (p >= 0.62) {
      /* ---- openings ------------------------------------------------- */
      const lintelL = stone ? shade(wl, 0.2) : undefined;
      const lintelR = stone ? shade(wr, 0.2) : undefined;
      const cols = Math.max(1, Math.floor(W / 22));
      for (let f = 0; f < floors; f++) {
        const hc = f * STORY + STORY * 0.6;
        for (let i = 0; i < cols; i++) {
          const t = cols === 1 ? 0.5 : 0.18 + (0.64 * i) / (cols - 1);
          const doorSlot = f === 0 && Math.abs(t - 0.5) < 0.16;
          const lit = spec.lit || rng() < 0.2;
          if (!doorSlot) drawWindow(ctx, W, 'l', t, hc, lit, lintelL);
          if (role !== 'barn' || f > 0) {
            drawWindow(ctx, W, 'r', t, hc, spec.lit || rng() < 0.16, lintelR);
          }
        }
      }

      /* ---- door ------------------------------------------------------ */
      const dw = role === 'barn' ? 9 : 5;
      const dh = role === 'barn' ? 13 : 10.5;
      const dt = dw / W;
      poly(ctx, qL(W, 0.5 - dt * 1.3, 0.5 + dt * 1.3, 0, dh + 1), PAL.woodDark);
      poly(ctx, qL(W, 0.5 - dt, 0.5 + dt, 0, dh), role === 'smithy' ? PAL.forge : PAL.wood);
      if (role !== 'smithy') {
        poly(ctx, qL(W, 0.5 - dt, 0.5 - dt * 0.32, 0, dh), PAL.woodLight);
        const knob = leftPt(W, 0.5 + dt * 0.5, dh * 0.5);
        rect(ctx, knob[0], knob[1], 1, 1, PAL.glassLit);
      }
      poly(ctx, qL(W, 0.5 - dt * 1.6, 0.5 + dt * 1.6, -1.5, 0.4), PAL.stone);
      // A dressed lintel across the door head: the one stone detail big enough
      // to survive the fitted overview, so it is worth spending the pixels on.
      if (stone) {
        poly(ctx, qL(W, 0.5 - dt * 1.8, 0.5 + dt * 1.8, dh + 1, dh + 3.2), shade(wl, 0.2));
      }

      if (spec.awning) {
        const a0 = leftPt(W, 0.5 - dt * 2.4, 13);
        const a1 = leftPt(W, 0.5 + dt * 2.4, 13);
        const px = -8;
        const py = 4;
        const lerp = (t: number): Pt => [a0[0] + (a1[0] - a0[0]) * t, a0[1] + (a1[1] - a0[1]) * t];
        const canopy = (t0: number, t1: number, color: string) => {
          const q0 = lerp(t0);
          const q1 = lerp(t1);
          poly(ctx, [q0, q1, [q1[0] + px, q1[1] + py], [q0[0] + px, q0[1] + py]], color);
        };
        canopy(0, 1, accent);
        canopy(0.28, 0.48, PAL.wall);
        canopy(0.68, 0.88, PAL.wall);
        const f0 = lerp(0);
        const f1 = lerp(1);
        poly(ctx, [
          [f0[0] + px, f0[1] + py],
          [f1[0] + px, f1[1] + py],
          [f1[0] + px, f1[1] + py + 3],
          [f0[0] + px, f0[1] + py + 3],
        ], shade(accent, -0.32));
      }
    }

    /* ---- roof ------------------------------------------------------- */
    let roofH = 0;
    if (p >= 0.62) {
      roofH = drawRoof(ctx, W, wallH, roof, accent, condition, spec.material);
    } else {
      // Ring beam and bare rafters, sitting on the frame at its final plate
      // height — the roof is what is missing, not the storey.
      poly(ctx, qL(W, 0, 1, wallH - 2.5, wallH), PAL.woodLight);
      poly(ctx, qR(W, 0, 1, wallH - 2.5, wallH), PAL.wood);
      for (const t of [0.06, 0.5, 0.94]) {
        poly(ctx, qL(W, t - 1.4 / W, t + 1.4 / W, wallH, wallH + 9), PAL.wood);
      }
    }

    /* ---- role furniture --------------------------------------------- */
    if (role === 'tower') {
      const tw = 15;
      const th = wallH + towerH;
      const tx = -W / 2 + 9;
      const ty = -H / 4 + 2;
      ctx.save();
      ctx.translate(tx, ty);
      poly(ctx, [[-tw / 2, 0], [0, tw / 4], [0, tw / 4 - th], [-tw / 2, -th]], PAL.wall);
      poly(ctx, [[0, tw / 4], [tw / 2, 0], [tw / 2, -th], [0, tw / 4 - th]], PAL.wallShade);
      poly(ctx, [
        [-tw / 2 + 2, -th + 11],
        [-2, -th + 13],
        [-2, -th + 5],
        [-tw / 2 + 2, -th + 3],
      ], shade(PAL.glassLit, 0.12));
      rect(ctx, -tw / 2 + 4, -th + 6, 1, 4, PAL.ink);
      rect(ctx, -tw / 2 + 4, -th + 9, 3, 1, PAL.ink);
      poly(ctx, [[-tw / 2 - 2, -th], [0, -th + tw / 4 + 1], [0, -th - 16]], shade(accent, -0.14));
      poly(ctx, [[0, -th + tw / 4 + 1], [tw / 2 + 2, -th], [0, -th - 16]], shade(accent, -0.34));
      rect(ctx, 0, -th - 21, 1, 6, PAL.ink);
      poly(ctx, [[1, -th - 21], [7, -th - 19], [1, -th - 17]], accent);
      ctx.restore();
    }

    if (role === 'granary') {
      const sw = 14;
      const sx = W / 2 - 10;
      const sy = W / 4 - (W / 2 - 10) / 2;
      ctx.save();
      ctx.translate(sx, sy);
      poly(ctx, [[-sw / 2, 0], [0, sw / 4], [0, sw / 4 - siloH], [-sw / 2, -siloH]], PAL.stoneLight);
      poly(ctx, [[0, sw / 4], [sw / 2, 0], [sw / 2, -siloH], [0, sw / 4 - siloH]], PAL.stone);
      for (let k = 6; k < siloH; k += 7) {
        poly(ctx, [[-sw / 2, -k], [0, sw / 4 - k], [0, sw / 4 - k + 1], [-sw / 2, -k + 1]], shade(PAL.stoneLight, -0.12));
      }
      poly(ctx, diamond(0, -siloH + sw / 4, sw + 4), shade(accent, -0.2));
      poly(ctx, [[-sw / 2 - 2, -siloH + sw / 4], [sw / 2 + 2, -siloH + sw / 4], [0, -siloH - 8]], accent);
      ctx.restore();
    }

    if (role === 'mill') {
      // Waterwheel housing on the right-hand face; the wheel itself is drawn
      // per-frame by the renderer so it can turn.
      const wx = W / 2 + 5;
      const wy = -6;
      rect(ctx, wx - 2, wy - 12, 4, 14, PAL.woodDark);
      wheel = [wx + 5, wy - 4];
    }

    if (role === 'smithy') {
      poly(ctx, qL(W, 0.16, 0.3, 2, 7), PAL.forge);
      rect(ctx, -W / 4 - 3, -4, 7, 4, PAL.stoneDark);
    }

    if (role === 'bakery') {
      // A stone dome oven bulging off the right-hand gable, its firing arch
      // still glowing. The flue is stubby; the roof chimney does the smoke.
      const ox = W / 2 + 4;
      const oy = 1;
      poly(ctx, diamond(ox + 1, oy + 2, 21), PAL.shadow);
      blob(ctx, ox, oy - 12, [8, 13, 16, 18, 18, 17, 16, 14, 12, 9, 5], PAL.stone);
      blob(ctx, ox - 3, oy - 11, [6, 9, 9, 7], PAL.stoneLight);
      poly(ctx, [[ox - 5, oy], [ox + 5, oy], [ox + 4, oy - 6], [ox - 4, oy - 6]], PAL.stoneDark);
      poly(ctx, [[ox - 3, oy], [ox + 3, oy], [ox + 2, oy - 4], [ox - 2, oy - 4]], PAL.forge);
      poly(ctx, [[ox - 2, oy], [ox + 2, oy], [ox + 1, oy - 2], [ox - 1, oy - 2]], PAL.glassLit);
      rect(ctx, ox - 1, oy - 19, 3, 7, PAL.stoneDark);
      rect(ctx, ox - 2, oy - 20, 5, 1, PAL.stone);
      // paddle and a rack of loaves leaning on the wall
      rect(ctx, -W / 4, -6, 1, 7, PAL.woodLight);
      rect(ctx, -W / 4 - 2, -9, 5, 3, PAL.wood);
    }

    if (role === 'brewhouse') {
      // Oast house: a stone drum standing off the west corner with a conical
      // kiln roof and a white cowl on top. It has to clear the ridge — a cone
      // the same colour as the roof and the same height as the roof is a cone
      // nobody can see.
      const kw = 18;
      const kb = wallH + 6;
      const kx = -W / 2 + 6;
      const ky = 0;
      const eaveY = -kb + kw / 4;
      const top = -kb - kilnH;
      ctx.save();
      ctx.translate(kx, ky);
      poly(ctx, diamond(2, 3, kw + 4), PAL.shadow);
      poly(ctx, [[-kw / 2, 0], [0, kw / 4], [0, kw / 4 - kb], [-kw / 2, -kb]], PAL.stoneLight);
      poly(ctx, [[0, kw / 4], [kw / 2, 0], [kw / 2, -kb], [0, kw / 4 - kb]], PAL.stone);
      for (let k = 8; k < kb; k += 9) {
        poly(ctx, [[-kw / 2, -k], [0, kw / 4 - k], [0, kw / 4 - k + 1], [-kw / 2, -k + 1]], PAL.stoneDark);
      }
      poly(ctx, [[-kw / 2 + 2, -4], [-3, -4 + kw / 4 - 1], [-3, -14], [-kw / 2 + 2, -14 - kw / 4 + 1]], PAL.woodDark);
      poly(ctx, diamond(0, eaveY, kw + 6), shade(accent, -0.42));
      poly(ctx, [[-kw / 2 - 3, eaveY], [0, eaveY + kw / 4 + 1.5], [0, top]], accent);
      poly(ctx, [[0, eaveY + kw / 4 + 1.5], [kw / 2 + 3, eaveY], [0, top]], shade(accent, -0.3));
      poly(ctx, [[-kw / 4 - 1, (eaveY + top) / 2], [0, top], [0, top + 3], [-kw / 4, (eaveY + top) / 2 + 3]], shade(accent, 0.24));
      rect(ctx, -3, top - 7, 7, 8, PAL.chalk);
      rect(ctx, 1, top - 7, 3, 8, shade(PAL.chalk, -0.16));
      poly(ctx, [[-4, top - 8], [4, top - 8], [0, top - 13]], PAL.stoneLight);
      rect(ctx, 4, top - 6, 6, 1, PAL.woodDark);
      ctx.restore();
      // barrels waiting on the yard side
      rect(ctx, W / 5, -8, 8, 8, PAL.wood);
      rect(ctx, W / 5, -8, 3, 8, PAL.woodLight);
      rect(ctx, W / 5, -6, 8, 1, PAL.stoneDark);
      rect(ctx, W / 5, -2, 8, 1, PAL.stoneDark);
    }

    if (role === 'gildhall' && p >= 0.62 && roof !== 'flat') {
      // A charter building. Everything here is gilt: the eaves, the ridge, a
      // lamp on the ridge end and a plaque by the door. Gold rather than the
      // town's accent, because the point of the silhouette is that this one
      // roof was paid for by something nobody in the valley worked for.
      const GOLD = '#f2cc63';
      const GOLD_D = '#c1912f';
      const GOLD_L = '#ffeaa8';
      const RW = W + 8;
      const ry = -wallH;
      const Ec: Pt = [RW / 2, ry];
      const Sc: Pt = [0, ry + RW / 4];
      const Wc: Pt = [-RW / 2, ry];
      poly(ctx, [Wc, Sc, [Sc[0], Sc[1] + 2.2], [Wc[0], Wc[1] + 2.2]], GOLD);
      poly(ctx, [Sc, Ec, [Ec[0], Ec[1] + 2.2], [Sc[0], Sc[1] + 2.2]], GOLD_D);

      const hip = roof === 'hip';
      const r1: Pt = hip ? [0, ry - roofH] : [-RW / 4, ry - RW / 8 - roofH];
      const r2: Pt = hip ? [0, ry - roofH] : [RW / 4, ry + RW / 8 - roofH];
      if (!hip) {
        poly(ctx, [r1, r2, [r2[0], r2[1] + 2.2], [r1[0], r1[1] + 2.2]], GOLD_D);
        poly(ctx, [r1, r2, [r2[0], r2[1] + 1], [r1[0], r1[1] + 1]], GOLD_L);
      } else {
        poly(ctx, [[r1[0] - 4, r1[1] + 2], [r1[0] + 4, r1[1] + 2], [r1[0], r1[1] - 1]], GOLD);
      }
      const fx = Math.round(r1[0]);
      const fy = Math.round(r1[1]);
      rect(ctx, fx - 1, fy - 8, 1, 8, GOLD_D);
      rect(ctx, fx - 3, fy - 12, 5, 4, PAL.glassLit);
      rect(ctx, fx - 4, fy - 13, 7, 1, GOLD);
      rect(ctx, fx - 4, fy - 8, 7, 1, GOLD);

      // charter plaque, screwed to the wall beside the door
      const pw = 3.2 / W;
      poly(ctx, qL(W, 0.5 + pw * 2, 0.5 + pw * 3.8, 6, 11.5), GOLD_D);
      poly(ctx, qL(W, 0.5 + pw * 2.2, 0.5 + pw * 3.6, 6.8, 10.7), GOLD);
    }

    if (spec.cupola && p >= 0.62) {
      const cy = -wallH - roofH - 2;
      rect(ctx, -5, cy - 9, 10, 9, PAL.wall);
      rect(ctx, 0, cy - 9, 5, 9, PAL.wallShade);
      rect(ctx, -3, cy - 7, 6, 5, PAL.ink);
      poly(ctx, [[-2, cy - 3], [2, cy - 3], [1, cy - 7], [-1, cy - 7]], PAL.glassLit);
      poly(ctx, [[-7, cy - 9], [7, cy - 9], [0, cy - 17]], accent);
      rect(ctx, 0, cy - 21, 1, 4, PAL.ink);
    }

    if (spec.antenna && p >= 0.62) {
      rect(ctx, W / 5, -wallH - 22, 1, 14, PAL.ink);
      rect(ctx, W / 5 - 3, -wallH - 20, 7, 1, PAL.ink);
      rect(ctx, W / 5 - 2, -wallH - 17, 5, 1, PAL.ink);
      rect(ctx, W / 5, -wallH - 24, 1, 2, PAL.flower[0]);
    }

    if (spec.chimney && p >= 0.62) {
      const cx = W / 4;
      const cy = -wallH - roofH * 0.42;
      rect(ctx, cx - 3, cy - 13, 6, 14, PAL.stone);
      rect(ctx, cx, cy - 13, 3, 14, PAL.stoneDark);
      rect(ctx, cx - 4, cy - 15, 8, 2, shade(PAL.stone, -0.25));
      smoke = [cx, cy - 16];
    }

    /* ---- still working on it ---------------------------------------- */
    if (!finished) {
      drawScaffold(ctx, W, wallH + (p >= 0.62 ? roofH * 0.5 : 0) + 4);
      // Site marker: a ribboned stake in the village's own colour, clearing the
      // scaffold, so every plot still going up is spottable from the road — and
      // from the fitted overview, where the scaffold itself is three pixels.
      const mh = Math.round(wallH + (p >= 0.62 ? roofH : 12) + 17);
      rect(ctx, -W / 2 - 1, -mh, 1, mh + 1, PAL.woodLight);
      rect(ctx, -W / 2 - 2, -mh - 1, 3, 1, PAL.woodDark);
      poly(ctx, [
        [-W / 2, -mh],
        [-W / 2 + 10, -mh + 3],
        [-W / 2, -mh + 6],
      ], accent);
    }

    /* ---- banner: the project's gem colour, readable from a distance --- */
    if (spec.banner && finished) {
      const bx = -W / 4;
      const by = -wallH - roofH - (roof === 'flat' ? 5 : 0);
      rect(ctx, bx, by - 19, 2, 20, PAL.ink);
      poly(ctx, [[bx + 1, by - 20], [bx + 14, by - 16.5], [bx + 1, by - 12]], PAL.ink);
      poly(ctx, [[bx + 2, by - 19], [bx + 12, by - 16.5], [bx + 2, by - 13.5]], accent);
    }
  });

  return { ...sp, smoke, wheel };
}

/* ------------------------------- scenery ------------------------------- */

/**
 * Tree sprites. 0 oak, 1 pine, 2 blossom, 3 hedgerow — and, added for Genesis
 * and unused by the vale, 4 birch, 5 willow, 6 fir. Every new kind is a fresh
 * branch above the hedgerow fallback, so 0..3 still draw exactly what they did.
 */
export function buildTree(kind: 0 | 1 | 2 | 3 | 4 | 5 | 6, seed: number): Sprite {
  const rng = mulberry32(seed);
  if (kind === 0) {
    const leaf = PAL.leaf[Math.floor(rng() * PAL.leaf.length)];
    return makeSprite(30, 38, 15, 34, (ctx) => {
      poly(ctx, diamond(1, 1, 18), PAL.shadow);
      rect(ctx, -2, -20, 4, 20, PAL.wood);
      rect(ctx, 0, -20, 2, 20, PAL.woodDark);
      blob(ctx, 0, -32, [6, 10, 14, 18, 20, 22, 22, 22, 20, 18, 14, 10, 7, 4], leaf);
      blob(ctx, -4, -31, [6, 10, 12, 12, 10, 8, 6], shade(leaf, 0.26));
      blob(ctx, 4, -24, [8, 10, 10, 8, 5], shade(leaf, -0.2));
    });
  }
  if (kind === 1) {
    const leaf = PAL.leaf[Math.floor(rng() * PAL.leaf.length)];
    const h = 42;
    return makeSprite(26, h + 8, 13, h + 3, (ctx) => {
      poly(ctx, diamond(1, 1, 16), PAL.shadow);
      rect(ctx, -1, -8, 3, 8, PAL.woodDark);
      for (let i = 0; i < 3; i++) {
        const y = -8 - i * 9;
        const w = 20 - i * 5;
        poly(ctx, [[-w / 2, y], [w / 2, y], [0, y - 16]], i === 0 ? shade(leaf, -0.16) : leaf);
        poly(ctx, [[0, y], [w / 2, y], [0, y - 16]], shade(leaf, -0.3));
      }
    });
  }
  if (kind === 2) {
    return makeSprite(26, 38, 13, 34, (ctx) => {
      poly(ctx, diamond(1, 1, 16), PAL.shadow);
      rect(ctx, -2, -16, 3, 16, PAL.wood);
      blob(ctx, 0, -27, [6, 12, 16, 20, 20, 20, 18, 14, 10, 6], PAL.blossom);
      blob(ctx, -4, -26, [6, 10, 10, 8, 5], shade(PAL.blossom, 0.3));
      blob(ctx, 4, -20, [7, 8, 6], shade(PAL.blossom, -0.16));
    });
  }
  if (kind === 4) {
    // Birch: a slim chalk trunk with dark scars and a high, airy crown. Reads
    // as a bright wood from across the valley.
    const leaf = shade(PAL.leaf[Math.floor(rng() * PAL.leaf.length)], 0.3);
    return makeSprite(28, 44, 14, 39, (ctx) => {
      poly(ctx, diamond(1, 1, 15), PAL.shadowSoft);
      rect(ctx, -1, -26, 3, 26, '#efe9dc');
      rect(ctx, 1, -26, 1, 26, '#cbc2b0');
      for (let i = 0; i < 4; i++) {
        rect(ctx, -1, -6 - i * 5 - (i % 2), 2, 1, PAL.ink);
      }
      poly(ctx, [[0, -19], [-6, -25], [-5, -25], [1, -20]], '#e2dbcb');
      blob(ctx, 0, -36, [6, 11, 15, 17, 18, 18, 17, 15, 12, 8, 5], leaf);
      blob(ctx, -3, -34, [5, 8, 8, 6], shade(leaf, 0.24));
      blob(ctx, 4, -28, [7, 8, 6, 4], shade(leaf, -0.2));
    });
  }
  if (kind === 5) {
    // Willow: a low mound of pale-gold foliage with fronds hanging off it.
    // Genesis puts these on the wet ground either side of the river.
    const leaf = mix(PAL.leaf[Math.floor(rng() * PAL.leaf.length)], '#cfd97e', 0.4);
    return makeSprite(36, 38, 18, 33, (ctx) => {
      poly(ctx, diamond(1, 1, 22), PAL.shadow);
      rect(ctx, -2, -19, 4, 19, PAL.wood);
      rect(ctx, 0, -19, 2, 19, PAL.woodDark);
      blob(ctx, 0, -28, [10, 16, 20, 23, 25, 25, 23, 20, 17], leaf);
      blob(ctx, -5, -27, [6, 10, 10, 7], shade(leaf, 0.26));
      for (let i = 0; i < 8; i++) {
        const x = -12 + i * 3.4;
        const h = 5 + Math.floor(rng() * 8);
        rect(ctx, x, -20, 1, h, i % 2 ? leaf : shade(leaf, -0.2));
        rect(ctx, x, -20 + h, 1, 1, shade(leaf, -0.34));
      }
    });
  }
  if (kind === 6) {
    // Dark fir: taller and narrower than the pine, and a good deal gloomier.
    const leaf = shade(PAL.leaf[Math.floor(rng() * PAL.leaf.length)], -0.38);
    return makeSprite(26, 62, 13, 57, (ctx) => {
      poly(ctx, diamond(1, 1, 14), PAL.shadow);
      rect(ctx, -1, -7, 3, 7, PAL.woodDark);
      for (let i = 0; i < 4; i++) {
        const y = -7 - i * 9;
        const w = 21 - i * 4.5;
        poly(ctx, [[-w / 2, y], [w / 2, y], [0, y - 16]], i % 2 ? shade(leaf, -0.12) : leaf);
        poly(ctx, [[0, y], [w / 2, y], [0, y - 16]], shade(leaf, -0.3));
      }
      rect(ctx, -1, -52, 2, 4, shade(leaf, 0.18));
    });
  }
  // autumn / hedgerow tree
  const leaf = PAL.leafAut[Math.floor(rng() * PAL.leafAut.length)];
  return makeSprite(28, 36, 14, 32, (ctx) => {
    poly(ctx, diamond(1, 1, 17), PAL.shadow);
    rect(ctx, -2, -18, 4, 18, PAL.woodDark);
    blob(ctx, 0, -29, [7, 12, 16, 19, 20, 20, 18, 15, 11, 7, 4], leaf);
    blob(ctx, -4, -28, [5, 8, 9, 7], shade(leaf, 0.28));
  });
}

export function buildStump(seed: number): Sprite {
  const rng = mulberry32(seed);
  const w = 8 + Math.floor(rng() * 4);
  return makeSprite(w + 10, 18, (w + 10) / 2, 13, (ctx) => {
    poly(ctx, diamond(1, 1, w + 6), PAL.shadow);
    poly(ctx, qL(w, 0, 1, 0, 5), PAL.wood);
    poly(ctx, qR(w, 0, 1, 0, 5), PAL.woodDark);
    poly(ctx, diamond(0, -5, w), PAL.woodLight);
    poly(ctx, diamond(0, -5, w * 0.45), shade(PAL.woodLight, -0.18));
    if (rng() < 0.5) rect(ctx, w / 2 - 2, -3, 3, 1, PAL.moss);
  });
}

export function buildBush(seed: number): Sprite {
  const rng = mulberry32(seed);
  const leaf = PAL.leaf[Math.floor(rng() * PAL.leaf.length)];
  return makeSprite(20, 16, 10, 13, (ctx) => {
    poly(ctx, diamond(1, 1, 14), PAL.shadow);
    blob(ctx, 0, -8, [7, 11, 14, 15, 15, 14, 12, 9, 5], leaf);
    blob(ctx, -3, -7, [5, 7, 6], shade(leaf, 0.28));
    if (rng() < 0.5) rect(ctx, 3, -5, 1, 1, PAL.flower[0]);
  });
}

export function buildRock(seed: number): Sprite {
  const rng = mulberry32(seed);
  const w = 9 + Math.floor(rng() * 6);
  return makeSprite(w + 6, 15, (w + 6) / 2, 11, (ctx) => {
    poly(ctx, diamond(1, 1, w + 3), PAL.shadow);
    blob(ctx, 0, -6, [w - 5, w - 2, w, w, w - 1, w - 3], PAL.stone);
    blob(ctx, -1, -6, [w - 7, w - 6], shade(PAL.stone, 0.22));
    if (rng() < 0.4) rect(ctx, -2, -2, 3, 1, PAL.moss);
  });
}

export function buildFlowerPatch(seed: number): Sprite {
  const rng = mulberry32(seed);
  return makeSprite(26, 16, 13, 10, (ctx) => {
    for (let i = 0; i < 10; i++) {
      const a = rng() * Math.PI * 2;
      const r = rng();
      const x = Math.cos(a) * r * 10;
      const y = (Math.sin(a) * r * 10) / 2;
      rect(ctx, x, y - 2, 1, 2, PAL.leafDark);
      rect(ctx, x, y - 3, 1, 1, PAL.flower[Math.floor(rng() * PAL.flower.length)]);
    }
  });
}

export function buildReeds(seed: number): Sprite {
  const rng = mulberry32(seed);
  return makeSprite(20, 20, 10, 15, (ctx) => {
    for (let i = 0; i < 7; i++) {
      const x = Math.round((rng() - 0.5) * 14);
      const h = 6 + Math.round(rng() * 6);
      rect(ctx, x, -h, 1, h, PAL.leafDark);
      if (rng() < 0.5) rect(ctx, x, -h - 3, 1, 3, '#a97e4f');
    }
  });
}

/** A short run of picket fence along the screen-x axis. */
export function buildFence(dir: 'l' | 'r'): Sprite {
  const w = 34;
  return makeSprite(w + 4, 32, (w + 4) / 2, 21, (ctx) => {
    const s = dir === 'l' ? 1 : -1;
    for (let i = 0; i <= 4; i++) {
      const x = -w / 2 + (i * w) / 4;
      const y = (s * x) / 2;
      rect(ctx, x, y - 9, 2, 10, PAL.woodLight);
      rect(ctx, x, y - 10, 2, 1, PAL.wall);
    }
    poly(ctx, [
      [-w / 2, (s * -w) / 4 - 6],
      [w / 2, (s * w) / 4 - 6],
      [w / 2, (s * w) / 4 - 4.4],
      [-w / 2, (s * -w) / 4 - 4.4],
    ], PAL.wood);
  });
}

/** A tilled 2×2-tile plot with rows of seedlings. */
export function buildCropRow(seed: number): Sprite {
  const rng = mulberry32(seed);
  const crop = PAL.crop[Math.floor(rng() * PAL.crop.length)];
  return makeSprite(76, 48, 38, 36, (ctx) => {
    poly(ctx, diamond(0, 1, 66), PAL.tillDark);
    poly(ctx, diamond(0, 0, 60), PAL.till);
    poly(ctx, diamond(0, -1, 52), shade(PAL.till, 0.14));
    for (let r = 0; r < 4; r++) {
      const gy = -0.62 + r * 0.41;
      for (let i = 0; i < 7; i++) {
        const gx = -0.78 + i * 0.26;
        const x = Math.round((gx - gy) * 16);
        const y = Math.round((gx + gy) * 8);
        rect(ctx, x, y - 4, 1, 4, crop);
        rect(ctx, x - 1, y - 5, 3, 1, crop);
        rect(ctx, x - 1, y - 3, 1, 1, shade(crop, -0.2));
      }
    }
  });
}

export function buildHaystack(seed: number): Sprite {
  const rng = mulberry32(seed);
  const w = 20 + Math.floor(rng() * 6);
  return makeSprite(w + 8, 30, (w + 8) / 2, 25, (ctx) => {
    poly(ctx, diamond(1, 1, w + 4), PAL.shadow);
    blob(ctx, 0, -17, [4, 8, 12, 15, 17, 19, w - 4, w - 2, w, w, w - 1, w - 3, w - 6, 4], '#e9c073');
    blob(ctx, -3, -16, [3, 6, 8, 9, 8, 6], '#f4d492');
    for (let i = 0; i < 5; i++) rect(ctx, -w / 2 + 3 + i * 4, -6 - (i % 2), 2, 1, '#c99b4e');
    rect(ctx, 0, -21, 1, 4, PAL.woodDark);
  });
}

export function buildShed(seed: number): Sprite {
  const rng = mulberry32(seed);
  const W = 20;
  const wallH = 10;
  const roofH = 8;
  const accent = rng() < 0.5 ? '#c98f6a' : '#a8a2b8';
  return makeSprite(W + 16, 42, (W + 16) / 2, 32, (ctx) => {
    poly(ctx, diamond(2, 2, W + 6), PAL.shadow);
    poly(ctx, qL(W, 0, 1, 0, wallH), PAL.woodLight);
    poly(ctx, qR(W, 0, 1, 0, wallH), PAL.wood);
    poly(ctx, qL(W, 0.36, 0.64, 0, 8), PAL.woodDark);
    const RW = W + 6;
    const ry = -wallH;
    const N: Pt = [0, ry - RW / 4];
    const E: Pt = [RW / 2, ry];
    const S: Pt = [0, ry + RW / 4];
    const Wc: Pt = [-RW / 2, ry];
    const R1: Pt = [-RW / 4, ry - RW / 8 - roofH];
    const R2: Pt = [RW / 4, ry + RW / 8 - roofH];
    poly(ctx, [N, E, R2, R1], shade(accent, -0.32));
    poly(ctx, [E, S, R2], shade(accent, -0.14));
    poly(ctx, [Wc, S, R2, R1], accent);
    poly(ctx, [Wc, S, [S[0], S[1] + 2], [Wc[0], Wc[1] + 2]], shade(accent, -0.45));
  });
}

export function buildCart(loaded: boolean): Sprite {
  return makeSprite(30, 28, 15, 22, (ctx) => {
    poly(ctx, diamond(1, 1, 22), PAL.shadow);
    poly(ctx, [[-11, -6], [0, -1], [11, -6], [11, -11], [0, -6], [-11, -11]], PAL.woodLight);
    poly(ctx, [[-11, -11], [0, -6], [0, -1], [-11, -6]], PAL.wood);
    rect(ctx, -8, -6, 2, 6, PAL.woodDark);
    rect(ctx, 5, -6, 2, 6, PAL.woodDark);
    rect(ctx, -10, -4, 5, 5, PAL.ink);
    rect(ctx, 6, -4, 5, 5, PAL.ink);
    if (loaded) rect(ctx, -3, -15, 8, 5, '#e9c073');
  });
}

export function buildCrates(seed: number): Sprite {
  const rng = mulberry32(seed);
  return makeSprite(26, 26, 13, 22, (ctx) => {
    poly(ctx, diamond(1, 1, 20), PAL.shadow);
    const box = (x: number, y: number, s: number) => {
      poly(ctx, [[x - s, y], [x, y + s / 2], [x, y + s / 2 - s], [x - s, y - s]], PAL.woodLight);
      poly(ctx, [[x, y + s / 2], [x + s, y], [x + s, y - s], [x, y + s / 2 - s]], PAL.wood);
      poly(ctx, diamond(x, y - s, s * 2), shade(PAL.woodLight, 0.16));
    };
    box(-4, 0, 7);
    box(6, -2, 6);
    if (rng() < 0.6) box(-3, -14, 5);
  });
}

export function buildLumber(seed: number): Sprite {
  const rng = mulberry32(seed);
  return makeSprite(28, 27, 14, 22, (ctx) => {
    poly(ctx, diamond(1, 1, 24), PAL.shadow);
    for (let i = 0; i < 4; i++) {
      const y = -3 - i * 3;
      const x = -9 + i * 1.5;
      poly(ctx, [[x, y], [x + 17, y - 8], [x + 17, y - 5], [x, y + 3]], i % 2 ? PAL.woodLight : PAL.wood);
      poly(ctx, [[x, y], [x, y + 3], [x + 2, y + 4], [x + 2, y + 1]], PAL.woodDark);
    }
    if (rng() < 0.5) {
      rect(ctx, 8, -6, 5, 6, PAL.stoneDark);
      rect(ctx, 8, -7, 5, 1, PAL.stone);
    }
  });
}

export function buildWell(): Sprite {
  return makeSprite(30, 40, 15, 33, (ctx) => {
    poly(ctx, diamond(1, 1, 24), PAL.shadow);
    poly(ctx, diamond(0, 0, 22), PAL.stoneDark);
    poly(ctx, [[-11, 0], [0, 5.5], [0, -1.5], [-11, -7]], PAL.stone);
    poly(ctx, [[0, 5.5], [11, 0], [11, -7], [0, -1.5]], shade(PAL.stone, -0.14));
    poly(ctx, diamond(0, -7, 22), '#5f7f96');
    poly(ctx, diamond(0, -7, 14), '#7fb6cd');
    rect(ctx, -8, -22, 2, 15, PAL.wood);
    rect(ctx, 6, -22, 2, 15, PAL.wood);
    poly(ctx, [[-11, -22], [0, -30], [11, -22], [11, -20], [0, -28], [-11, -20]], PAL.leafDark);
    rect(ctx, -1, -21, 1, 6, PAL.woodDark);
    rect(ctx, -3, -15, 5, 4, PAL.wood);
  });
}

export function buildLamp(): Sprite {
  return makeSprite(16, 42, 8, 37, (ctx) => {
    poly(ctx, diamond(1, 1, 12), PAL.shadow);
    poly(ctx, diamond(0, 0, 10), PAL.stoneDark);
    rect(ctx, -1, -26, 2, 26, PAL.ink);
    rect(ctx, -3, -32, 6, 6, shade(PAL.glassLit, -0.05));
    rect(ctx, -4, -33, 8, 1, PAL.ink);
    rect(ctx, -4, -26, 8, 1, PAL.ink);
    rect(ctx, -1, -35, 1, 2, PAL.ink);
  });
}

/** Road-side finger post. The lettering is HTML; this is just the timber. */
export function buildSignpost(accent: string): Sprite {
  return makeSprite(26, 32, 13, 27, (ctx) => {
    poly(ctx, diamond(1, 1, 14), PAL.shadow);
    rect(ctx, -1, -23, 2, 23, PAL.wood);
    poly(ctx, [[-9, -21], [7, -18], [7, -12], [-9, -15]], PAL.woodLight);
    poly(ctx, [[-9, -21], [7, -18], [7, -17], [-9, -20]], accent);
    rect(ctx, -6, -18, 8, 1, PAL.woodDark);
    rect(ctx, -6, -16, 5, 1, PAL.woodDark);
  });
}

/** Village name board: two posts and a painted plank in the gem colour. */
export function buildNameBoard(accent: string): Sprite {
  return makeSprite(44, 34, 22, 29, (ctx) => {
    poly(ctx, diamond(1, 1, 26), PAL.shadow);
    rect(ctx, -15, -20, 2, 21, PAL.wood);
    rect(ctx, 13, -14, 2, 15, PAL.wood);
    poly(ctx, [[-16, -22], [16, -16], [16, -6], [-16, -12]], PAL.woodDark);
    poly(ctx, [[-15, -21], [15, -15.4], [15, -7.4], [-15, -13]], PAL.woodLight);
    poly(ctx, [[-15, -21], [15, -15.4], [15, -14.2], [-15, -19.8]], accent);
    poly(ctx, [[-15, -9.6], [15, -8.6], [15, -7.4], [-15, -13 + 4.6]], accent);
  });
}

/** Surveyor stake with a ribbon — the frontier's calling card. */
export function buildStake(accent: string, seed: number): Sprite {
  const rng = mulberry32(seed);
  return makeSprite(14, 24, 7, 20, (ctx) => {
    poly(ctx, diamond(1, 1, 8), PAL.shadowSoft);
    rect(ctx, 0, -13, 1, 13, PAL.woodLight);
    poly(ctx, [[1, -13], [7, -11.5], [1, -9.5]], accent);
    if (rng() < 0.5) rect(ctx, -2, -1, 5, 1, PAL.chalk);
  });
}

export function buildCampfire(): Sprite {
  return makeSprite(22, 22, 11, 17, (ctx) => {
    poly(ctx, diamond(1, 1, 16), PAL.shadowSoft);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      rect(ctx, Math.cos(a) * 7, (Math.sin(a) * 7) / 2 - 1, 2, 2, PAL.stone);
    }
    poly(ctx, [[-4, -1], [4, -3], [3, -1], [-3, 1]], PAL.woodDark);
    poly(ctx, [[-3, -1], [3, -4], [2, -1], [-2, 1]], PAL.wood);
    poly(ctx, [[-3, -2], [3, -2], [0, -9]], '#ff9a4d');
    poly(ctx, [[-2, -2], [2, -2], [0, -6]], '#ffd98a');
  });
}

export function buildBarrels(seed: number): Sprite {
  const rng = mulberry32(seed);
  return makeSprite(24, 24, 12, 19, (ctx) => {
    poly(ctx, diamond(1, 1, 18), PAL.shadow);
    const barrel = (x: number, y: number) => {
      rect(ctx, x - 4, y - 11, 8, 11, PAL.wood);
      rect(ctx, x - 4, y - 11, 3, 11, PAL.woodLight);
      rect(ctx, x - 4, y - 9, 8, 1, PAL.stoneDark);
      rect(ctx, x - 4, y - 4, 8, 1, PAL.stoneDark);
      poly(ctx, diamond(x, y - 11, 8), shade(PAL.woodLight, 0.2));
    };
    barrel(-4, 1);
    barrel(5, -2);
    if (rng() < 0.5) barrel(0, -12);
  });
}

/** Grazing animal: reads as a sheep at 1× and a white speck on the map. */
export function buildSheep(seed: number): Sprite {
  const rng = mulberry32(seed);
  const flip = rng() < 0.5 ? 1 : -1;
  return makeSprite(18, 16, 9, 12, (ctx) => {
    poly(ctx, diamond(1, 1, 12), PAL.shadowSoft);
    rect(ctx, -4 * flip, -3, 1, 3, PAL.ink);
    rect(ctx, 2 * flip, -3, 1, 3, PAL.ink);
    blob(ctx, 0, -9, [7, 10, 11, 10, 8], '#f4efe6');
    blob(ctx, -1, -9, [4, 5], '#ffffff');
    rect(ctx, 5 * flip, -9, 3, 3, '#4c4658');
  });
}

/**
 * A quarry town's stone yard: dressed blocks stacked and waiting to go up,
 * with the chisel and a wedge still lying on the top course. Genesis-only and
 * additive — the vale never asks for this kind.
 *
 * It has to read as *cut* stone rather than as boulders, so every face is a
 * flat quad with a hard highlight on the top: a rounded blob at this size is
 * indistinguishable from `buildRock`, which is exactly what these are not.
 */
export function buildQuarryBlocks(seed: number): Sprite {
  const rng = mulberry32(seed);
  /** One dressed block, drawn as an iso box of on-screen width `w`. */
  const block = (ctx: Ctx, cx: number, cy: number, w: number, h: number, tint: number) => {
    // The three faces are pushed a long way apart in value on purpose: a
    // dressed block is defined by its flat lit top, and a gentle ramp between
    // top and side is exactly what makes a stack of these read as boulders.
    const top = shade(PAL.masonry, 0.34 + tint);
    const left = shade(PAL.masonry, tint);
    const right = shade(PAL.masonryShade, -0.14 + tint);
    poly(ctx, [[cx - w / 2, cy], [cx, cy - w / 4], [cx + w / 2, cy], [cx, cy + w / 4]], top);
    poly(ctx, [
      [cx - w / 2, cy],
      [cx, cy + w / 4],
      [cx, cy + w / 4 + h],
      [cx - w / 2, cy + h],
    ], left);
    poly(ctx, [
      [cx, cy + w / 4],
      [cx + w / 2, cy],
      [cx + w / 2, cy + h],
      [cx, cy + w / 4 + h],
    ], right);
    // a hard shadow line under the block, so a stack reads as courses
    poly(ctx, [
      [cx - w / 2, cy + h],
      [cx, cy + w / 4 + h],
      [cx + w / 2, cy + h],
      [cx + w / 2, cy + h + 1],
      [cx, cy + w / 4 + h + 1],
      [cx - w / 2, cy + h + 1],
    ], shade(PAL.masonryShade, -0.34));
    // one chiselled arris, so the block has an edge rather than a seam
    poly(ctx, [
      [cx - w / 2, cy],
      [cx, cy - w / 4],
      [cx, cy - w / 4 + 1],
      [cx - w / 2, cy + 1],
    ], shade(PAL.masonry, 0.5));
  };
  const tall = rng() < 0.5;
  return makeSprite(34, 30, 17, 24, (ctx) => {
    poly(ctx, diamond(1, 1, 26), PAL.shadow);
    block(ctx, -5, -1, 16, 6, -0.05);
    block(ctx, 6, 2, 16, 6, 0.02);
    block(ctx, 0, -8, 16, 6, 0.06);
    if (tall) block(ctx, 1, -15, 13, 5, -0.02);
    // chisel and wedge left on the top course
    const ty = tall ? -19 : -12;
    rect(ctx, -2, ty - 4, 1, 5, PAL.woodDark);
    rect(ctx, -2, ty - 5, 2, 1, PAL.stoneDark);
    rect(ctx, 3, ty - 1, 4, 1, PAL.stoneLight);
    // a scatter of chippings on the ground
    for (let i = 0; i < 4; i++) {
      rect(ctx, -12 + rng() * 22, 1 + rng() * 5, 2, 1, shade(PAL.masonryShade, -0.1));
    }
  });
}

/**
 * A tileable patch of the deep woodland that surrounds the vale. Painting the
 * area outside the map with this instead of a flat colour means panning past
 * the edge — or viewing a wide map on a narrow phone — reads as endless forest
 * rather than as empty canvas.
 */
export function buildForestPattern(size = 96): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#3f7f66';
  ctx.fillRect(0, 0, size, size);
  const rng = mulberry32(9001);
  // Wrapped drawing: every blob is stamped in all nine offsets so the tile seams.
  const stamp = (draw: (dx: number, dy: number) => void, x: number, y: number) => {
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) draw(x + ox * size, y + oy * size);
    }
  };
  for (let i = 0; i < 70; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 3 + rng() * 5;
    const col = rng() < 0.42 ? '#377059' : rng() < 0.7 ? '#4a8d72' : '#2f6650';
    stamp((dx, dy) => {
      for (let k = -Math.round(r); k <= Math.round(r); k++) {
        const w = Math.round(Math.sqrt(Math.max(0, r * r - k * k)) * 2);
        if (w > 0) ctx.fillRect(Math.round(dx - w / 2), Math.round(dy + k * 0.55), w, 1);
      }
    }, x, y);
  }
  for (let i = 0; i < 40; i++) {
    const x = rng() * size;
    const y = rng() * size;
    stamp((dx, dy) => {
      ctx.fillStyle = '#2c6149';
      ctx.fillRect(Math.round(dx), Math.round(dy), 1, 2 + Math.round(rng() * 2));
    }, x, y);
  }
  return c;
}

/** Crane: mast + jib. The hook and its load are animated by the renderer. */
export function buildCrane(accent: string): Sprite {
  const mastH = 48;
  return makeSprite(72, mastH + 26, 26, mastH + 20, (ctx) => {
    poly(ctx, diamond(1, 1, 22), PAL.shadow);
    poly(ctx, diamond(0, 0, 20), PAL.stoneDark);
    poly(ctx, diamond(0, -2, 18), PAL.stone);
    for (let y = 0; y < mastH; y += 6) {
      rect(ctx, -4, -2 - y, 1, 6, PAL.wood);
      rect(ctx, 3, -2 - y, 1, 6, PAL.woodDark);
      rect(ctx, -4, -2 - y, 8, 1, PAL.woodLight);
      poly(ctx, [[-3, -2 - y], [-2, -2 - y], [4, -8 - y], [3, -8 - y]], shade(PAL.wood, 0.1));
    }
    const top = -mastH - 2;
    rect(ctx, -18, top, 44, 2, PAL.wood);
    rect(ctx, -18, top + 2, 44, 1, PAL.woodDark);
    for (let x = -16; x < 24; x += 6) {
      poly(ctx, [[x, top + 2], [x + 1, top + 2], [x + 5, top - 4], [x + 4, top - 4]], PAL.woodLight);
    }
    rect(ctx, -18, top - 5, 44, 1, PAL.woodLight);
    rect(ctx, -6, top + 3, 9, 7, accent);
    rect(ctx, -4, top + 5, 4, 3, PAL.glass);
    rect(ctx, -19, top - 2, 5, 8, PAL.stoneDark);
    rect(ctx, 25, top - 8, 2, 3, PAL.flower[0]);
  });
}

/**
 * The moving half of a crane: the hook line and the load swinging under the
 * jib. Drawn in `buildCrane`'s own local coordinates, so `x, y` is the same
 * anchor point the crane sprite was placed at.
 *
 * The Vale draws this inline in its entity pass; Genesis calls it here so the
 * two valleys swing the same load at the same rate.
 */
export function drawCraneLoad(ctx: Ctx, x: number, y: number, t: number): void {
  const jibX = 20;
  const topY = -50;
  const sway = Math.sin(t * 0.8) * 5;
  const drop = 24 + Math.sin(t * 0.55) * 9;
  const hx = Math.round(x) + Math.round(jibX + sway * 0.4);
  const hy = Math.round(y) + topY;
  ctx.fillStyle = PAL.ink;
  ctx.fillRect(hx, hy, 1, Math.round(drop));
  const lx = hx - 4;
  const ly = hy + Math.round(drop);
  ctx.fillStyle = PAL.woodLight;
  ctx.fillRect(lx, ly, 9, 6);
  ctx.fillStyle = PAL.wood;
  ctx.fillRect(lx, ly + 4, 9, 2);
  ctx.fillStyle = PAL.woodDark;
  ctx.fillRect(lx, ly, 9, 1);
}

/* ---------------------------- buried treasure --------------------------- */
/* Genesis only. Three states of one object: the mound nobody has noticed, the
 * chest standing in its hole with the earth thrown back, and the same chest
 * with the lid up. The anchor is the ground centre in all three, so the sprite
 * can be swapped underneath a fixed tile position without anything shifting. */

/** Point on the near-left / near-right face of a 18px chest body. */
const chestL = (t: number, h: number): Pt => [-9 + 9 * t, 4.5 * t - h];
const chestR = (t: number, h: number): Pt => [9 * t, 4.5 - 4.5 * t - h];

/** Body, bands and lock — shared by the closed and open chests. */
function chestBody(ctx: Ctx): void {
  poly(ctx, [chestL(0, 8), chestL(1, 8), chestL(1, 0), chestL(0, 0)], PAL.wood);
  poly(ctx, [chestR(0, 8), chestR(1, 8), chestR(1, 0), chestR(0, 0)], PAL.woodDark);
  for (const t of [0.24, 0.76]) {
    poly(ctx, [chestL(t - 0.07, 8), chestL(t + 0.07, 8), chestL(t + 0.07, 0), chestL(t - 0.07, 0)], PAL.stoneDark);
    poly(ctx, [chestR(t - 0.07, 8), chestR(t + 0.07, 8), chestR(t + 0.07, 0), chestR(t - 0.07, 0)], shade(PAL.stoneDark, -0.16));
  }
  poly(ctx, [chestL(0, 5), chestL(1, 5), chestL(1, 3.6), chestL(0, 3.6)], PAL.woodLight);
  poly(ctx, [chestR(0, 5), chestR(1, 5), chestR(1, 3.6), chestR(0, 3.6)], PAL.wood);
}

/**
 * A chest still in the ground: a low hump of turned earth going green again,
 * with one corner of a lid and one iron band showing. Meant to be *findable*
 * from the road, not obvious — a visitor who spots one before the settlers do
 * has earned it.
 */
export function buildChestMound(seed: number): Sprite {
  const rng = mulberry32(seed);
  return makeSprite(28, 22, 14, 16, (ctx) => {
    poly(ctx, diamond(1, 1, 22), PAL.shadowSoft);
    poly(ctx, diamond(0, 0, 21), shade(PAL.till, -0.14));
    poly(ctx, diamond(0, -2, 15), shade(PAL.till, 0.02));
    blob(ctx, -5, -6, [5, 8, 7, 4], PAL.moss);
    blob(ctx, 5, -4, [4, 6, 5], shade(PAL.moss, -0.14));
    poly(ctx, [[-6, -5], [1, -8.5], [6, -6], [-1, -2.5]], PAL.woodDark);
    poly(ctx, [[-5, -5.6], [0, -8], [3, -6.6], [-2, -4.2]], PAL.wood);
    rect(ctx, -1, -7, 3, 1, PAL.stoneDark);
    if (rng() < 0.55) rect(ctx, 6, -2, 2, 1, PAL.stone);
    if (rng() < 0.4) rect(ctx, -8, -1, 2, 1, PAL.stone);
  });
}

/**
 * The chest itself. `open` swings the lid up onto its hinges and fills the box
 * with what the day was worth. Closed is the dug-out state the crew works on;
 * open is what the valley gets to look at for the rest of the day.
 */
export function buildChest(open: boolean, seed: number): Sprite {
  const rng = mulberry32(seed);
  const H = open ? 40 : 28;
  return makeSprite(30, H, 15, H - 8, (ctx) => {
    poly(ctx, diamond(1, 1, 24), PAL.shadow);
    poly(ctx, diamond(0, 0, 22), shade(PAL.till, -0.06));
    poly(ctx, diamond(0, -1, 16), PAL.till);
    chestBody(ctx);

    if (!open) {
      // A domed lid, stepped in two courses so it reads as a chest and not as a
      // crate: full width to h10, inset to h12, then the boards on top.
      poly(ctx, [chestL(0, 10), chestL(1, 10), chestL(1, 8), chestL(0, 8)], PAL.woodLight);
      poly(ctx, [chestR(0, 10), chestR(1, 10), chestR(1, 8), chestR(0, 8)], PAL.wood);
      poly(ctx, [chestL(0.1, 12), chestL(0.9, 12), chestL(0.9, 10), chestL(0.1, 10)], shade(PAL.woodLight, 0.1));
      poly(ctx, [chestR(0.1, 12), chestR(0.9, 12), chestR(0.9, 10), chestR(0.1, 10)], PAL.woodLight);
      poly(ctx, diamond(0, -12, 15), shade(PAL.woodLight, 0.2));
      // one iron strap over the crown, and the lock plate on the front corner
      poly(ctx, [[-3.6, -13.6], [3.6, -10.2], [3.6, -8.9], [-3.6, -12.3]], PAL.stoneDark);
      poly(ctx, [chestL(0.44, 12), chestL(0.56, 12), chestL(0.56, 8), chestL(0.44, 8)], PAL.stoneDark);
      poly(ctx, [chestR(0.44, 12), chestR(0.56, 12), chestR(0.56, 8), chestR(0.44, 8)], shade(PAL.stoneDark, -0.16));
      rect(ctx, -2, -8, 4, 3, '#c1912f');
      rect(ctx, -1, -7, 1, 1, PAL.ink);
      return;
    }

    // The lid, standing on its hinges: we see the inside of it, banded like the
    // outside because whoever made this expected it to be argued with.
    const LH = 11;
    const lidL = (t: number, up: number): Pt => [-9 + 9 * t, -8 - 4.5 * t - up];
    const lidR = (t: number, up: number): Pt => [9 * t, -12.5 + 4.5 * t - up];
    poly(ctx, [lidL(0, LH), lidL(1, LH), lidL(1, 0), lidL(0, 0)], PAL.wood);
    poly(ctx, [lidR(0, LH), lidR(1, LH), lidR(1, 0), lidR(0, 0)], PAL.woodLight);
    for (const t of [0.26, 0.74]) {
      poly(ctx, [lidL(t - 0.07, LH), lidL(t + 0.07, LH), lidL(t + 0.07, 0), lidL(t - 0.07, 0)], shade(PAL.wood, -0.26));
      poly(ctx, [lidR(t - 0.07, LH), lidR(t + 0.07, LH), lidR(t + 0.07, 0), lidR(t - 0.07, 0)], PAL.stoneDark);
    }
    poly(ctx, [lidL(0, LH), lidL(1, LH), lidL(1, LH - 1.4), lidL(0, LH - 1.4)], PAL.stoneDark);
    poly(ctx, [lidR(0, LH), lidR(1, LH), lidR(1, LH - 1.4), lidR(0, LH - 1.4)], shade(PAL.stoneDark, 0.14));

    // …and what is in it.
    poly(ctx, diamond(0, -8, 18), '#4a3a2c');
    blob(ctx, 0, -12, [7, 12, 14, 12, 8], '#c1912f');
    blob(ctx, -1, -13, [6, 9, 9, 6], '#f2cc63');
    blob(ctx, 2, -12, [4, 5, 4], '#ffeaa8');
    rect(ctx, -4, -11, 1, 1, PAL.chalk);
    rect(ctx, 3, -13, 1, 1, PAL.chalk);
    if (rng() < 0.6) rect(ctx, -6, -9, 2, 1, '#ffeaa8');
  });
}

/**
 * The glint coming off an open chest: two or three pixels that wink on and off.
 * Drawn per frame by the renderer at the chest's ground anchor, so it never
 * gets baked into the sprite and never crawls.
 */
export function drawChestGlint(ctx: Ctx, x: number, y: number, t: number): void {
  const px = Math.round(x);
  const py = Math.round(y);
  const spots: [number, number, number][] = [
    [-3, -13, 0],
    [4, -11, 2.1],
    [0, -16, 4.3],
  ];
  for (const [dx, dy, ph] of spots) {
    const k = Math.sin(t * 2.4 + ph);
    if (k < 0.55) continue;
    ctx.fillStyle = k > 0.9 ? '#ffffff' : '#ffeaa8';
    ctx.fillRect(px + dx, py + dy, 1, 1);
    if (k > 0.9) {
      ctx.fillRect(px + dx - 1, py + dy, 1, 1);
      ctx.fillRect(px + dx + 1, py + dy, 1, 1);
      ctx.fillRect(px + dx, py + dy - 1, 1, 1);
      ctx.fillRect(px + dx, py + dy + 1, 1, 1);
    }
  }
}

/* ------------------------------- dynamics ------------------------------- */

export type BotAction = 'walk' | 'idle' | 'work' | 'carry';

/** A villager, ~14px tall, drawn straight into the frame buffer. */
export function drawBot(
  ctx: Ctx,
  x: number,
  y: number,
  color: string,
  faceRight: boolean,
  action: BotAction,
  phase: number
): void {
  const px = Math.round(x);
  const py = Math.round(y);
  const s = faceRight ? 1 : -1;
  const dark = shade(color, -0.28);
  const light = shade(color, 0.24);

  ctx.fillStyle = PAL.shadow;
  ctx.fillRect(px - 4, py - 1, 8, 2);
  ctx.fillRect(px - 5, py, 10, 1);

  const step = action === 'walk' || action === 'carry' ? Math.sin(phase * 9) : 0;
  const bob = step !== 0 && Math.abs(step) > 0.6 ? -1 : 0;
  const top = py + bob;

  ctx.fillStyle = PAL.ink;
  ctx.fillRect(px - 2, top - 3, 2, 3 + (step > 0 ? -1 : 0));
  ctx.fillRect(px + 1, top - 3, 2, 3 + (step < 0 ? -1 : 0));

  ctx.fillStyle = color;
  ctx.fillRect(px - 3, top - 9, 6, 6);
  ctx.fillStyle = dark;
  ctx.fillRect(px + (faceRight ? 2 : -3), top - 9, 1, 6);
  ctx.fillStyle = light;
  ctx.fillRect(px - 3 + (faceRight ? 0 : 5), top - 9, 1, 3);

  ctx.fillStyle = shade(color, -0.14);
  if (action === 'work') {
    const swing = Math.sin(phase * 11) > 0 ? 0 : 3;
    ctx.fillRect(px + s * 3 - (faceRight ? 0 : 1), top - 9 + swing, 1, 3);
    ctx.fillRect(px - s * 3 - (faceRight ? 1 : 0), top - 8, 1, 3);
    ctx.fillStyle = PAL.stoneDark;
    ctx.fillRect(px + s * 4 - (faceRight ? 0 : 2), top - 11 + swing * 2, 3, 2);
  } else if (action === 'carry') {
    ctx.fillRect(px - 4, top - 10, 1, 3);
    ctx.fillRect(px + 3, top - 10, 1, 3);
    ctx.fillStyle = PAL.woodLight;
    ctx.fillRect(px - 5, top - 13, 10, 3);
    ctx.fillStyle = PAL.wood;
    ctx.fillRect(px - 5, top - 11, 10, 1);
  } else {
    ctx.fillRect(px - 4, top - 8 + (step > 0 ? 1 : 0), 1, 3);
    ctx.fillRect(px + 3, top - 8 + (step < 0 ? 1 : 0), 1, 3);
  }

  ctx.fillStyle = '#f7e2c8';
  ctx.fillRect(px - 2, top - 14, 5, 5);
  ctx.fillStyle = '#e8cba9';
  ctx.fillRect(px + (faceRight ? 2 : -2), top - 14, 1, 5);
  ctx.fillStyle = dark;
  ctx.fillRect(px - 3, top - 16, 7, 2);
  ctx.fillRect(px - 2, top - 17, 5, 1);
  ctx.fillStyle = PAL.ink;
  if (action !== 'work') {
    ctx.fillRect(px + (faceRight ? 1 : -2), top - 12, 1, 1);
    ctx.fillRect(px + (faceRight ? -1 : 0), top - 12, 1, 1);
  }
}

/** A hand cart being pulled along a road, with its carter in front. */
export function drawCart(
  ctx: Ctx,
  x: number,
  y: number,
  color: string,
  faceRight: boolean,
  phase: number,
  cargo: string
): void {
  const px = Math.round(x);
  const py = Math.round(y);
  const s = faceRight ? 1 : -1;

  ctx.fillStyle = PAL.shadow;
  ctx.fillRect(px - 11, py - 1, 22, 2);

  const bx = px - s * 9;
  // bed
  ctx.fillStyle = PAL.wood;
  ctx.fillRect(bx - 7, py - 9, 14, 5);
  ctx.fillStyle = PAL.woodLight;
  ctx.fillRect(bx - 7, py - 9, 14, 1);
  ctx.fillStyle = PAL.woodDark;
  ctx.fillRect(bx - 7, py - 5, 14, 1);
  // cargo
  ctx.fillStyle = cargo;
  ctx.fillRect(bx - 5, py - 13, 10, 4);
  ctx.fillStyle = shade(cargo, 0.25);
  ctx.fillRect(bx - 5, py - 13, 10, 1);
  // wheels
  const spin = Math.floor(phase * 8) % 2;
  ctx.fillStyle = PAL.ink;
  ctx.fillRect(bx - 6, py - 5, 5, 5);
  ctx.fillRect(bx + 2, py - 5, 5, 5);
  ctx.fillStyle = PAL.woodLight;
  ctx.fillRect(bx - 4 + spin, py - 3, 1, 1);
  ctx.fillRect(bx + 4 - spin, py - 3, 1, 1);
  // shafts
  ctx.fillStyle = PAL.wood;
  ctx.fillRect(Math.min(px, bx) + (faceRight ? 7 : 0), py - 8, 6, 1);

  drawBot(ctx, px, py, color, faceRight, 'walk', phase);
}

/** Waterwheel: turns with the clock, so it lives outside the baked layer. */
export function drawWheel(ctx: Ctx, x: number, y: number, t: number): void {
  const cx = Math.round(x);
  const cy = Math.round(y);
  const r = 10;
  const a0 = t * 1.05;
  // rim
  ctx.fillStyle = PAL.woodDark;
  for (let i = 0; i < 28; i++) {
    const a = a0 + (i / 28) * Math.PI * 2;
    ctx.fillRect(cx + Math.round(Math.cos(a) * r) - 1, cy + Math.round(Math.sin(a) * r) - 1, 2, 2);
  }
  // spokes
  for (let i = 0; i < 8; i++) {
    const a = a0 + (i / 8) * Math.PI * 2;
    ctx.fillStyle = i % 2 ? PAL.wood : PAL.woodDark;
    for (let k = 2; k <= r; k++) {
      ctx.fillRect(cx + Math.round(Math.cos(a) * k), cy + Math.round(Math.sin(a) * k), 1, 1);
    }
  }
  // paddles, catching the light on the way down
  for (let i = 0; i < 8; i++) {
    const a = a0 + (i / 8) * Math.PI * 2;
    ctx.fillStyle = Math.sin(a) > 0 ? PAL.woodLight : PAL.wood;
    ctx.fillRect(cx + Math.round(Math.cos(a) * r) - 2, cy + Math.round(Math.sin(a) * r) - 2, 4, 4);
  }
  ctx.fillStyle = PAL.stoneDark;
  ctx.fillRect(cx - 2, cy - 2, 4, 4);
  ctx.fillStyle = PAL.stone;
  ctx.fillRect(cx - 1, cy - 1, 2, 2);
}

/* ------------------------------- wildlife ------------------------------- *
 * Ambient animal life, added for Genesis. Everything below this line is
 * additive: nothing above it calls anything here, so the vale's own scenes
 * draw exactly the pixels they always did.
 *
 * Scale reference is `buildSheep` — a grazing animal is ~12px tall and reads
 * as a pale speck from the overview. A deer is a shade taller and much
 * thinner; a dog is half a sheep; a bird is five pixels of silhouette.
 * Mirroring is done with `ctx.scale(-1, 1)` around the sprite anchor, which is
 * exact for the axis-aligned integer rectangles everything here is made of.
 * ------------------------------------------------------------------------ */

/** Earth-and-leaf coats, in the same register as PAL's wood and sand. */
const FUR = {
  deer: '#b07a49',
  deerDark: '#8a5c34',
  deerPale: '#e6d2ae',
  // A road dog is drawn on a dirt road, so a brown one is an invisible one:
  // this is a collie, dark with white points, and it reads at every zoom.
  dog: '#5b5170',
  dogDark: '#413a55',
  dogPale: '#f4efe6',
  bird: '#463f5c',
  birdWing: '#5d5675',
  fish: '#8fb9cc',
  fishDark: '#6d95a8',
} as const;

/**
 * A bird in flight: two frames of a flap, five pixels wide, symmetrical so it
 * needs no facing. Drawn small enough that only the wing beat reads at
 * distance — which is the whole point of it.
 */
export function buildBird(frame: 0 | 1): Sprite {
  return makeSprite(10, 10, 5, 5, (ctx) => {
    // body
    rect(ctx, -1, 0, 3, 1, FUR.bird);
    rect(ctx, 1, -1, 1, 1, FUR.bird);
    if (frame === 0) {
      // wings up
      rect(ctx, -2, -1, 1, 1, FUR.birdWing);
      rect(ctx, -3, -2, 1, 1, FUR.bird);
      rect(ctx, 2, -1, 1, 1, FUR.birdWing);
      rect(ctx, 3, -2, 1, 1, FUR.bird);
    } else {
      // wings down
      rect(ctx, -2, 1, 1, 1, FUR.birdWing);
      rect(ctx, -3, 2, 1, 1, FUR.bird);
      rect(ctx, 2, 1, 1, 1, FUR.birdWing);
      rect(ctx, 3, 2, 1, 1, FUR.bird);
    }
  });
}

/**
 * A deer, in the three poses the treeline needs: 0 head up and alert, 1 head
 * down and grazing, 2 bolting for the wood. `seed` only decides whether it is
 * a stag, so a pair at the same spot is not a pair of twins.
 */
export function buildDeer(pose: 0 | 1 | 2, faceRight: boolean, seed: number): Sprite {
  const antlers = mulberry32(seed)() < 0.45;
  return makeSprite(22, 20, 9, 17, (ctx) => {
    if (!faceRight) ctx.scale(-1, 1);
    poly(ctx, diamond(0, 1, 12), PAL.shadowSoft);

    if (pose === 2) {
      // legs thrown out fore and aft
      rect(ctx, 5, -4, 1, 2, FUR.deerDark);
      rect(ctx, 6, -2, 2, 1, FUR.deerDark);
      rect(ctx, 3, -5, 1, 4, FUR.deer);
      rect(ctx, -5, -4, 1, 2, FUR.deerDark);
      rect(ctx, -7, -2, 2, 1, FUR.deerDark);
      rect(ctx, -3, -5, 1, 4, FUR.deer);
      blob(ctx, 0, -9, [7, 9, 9, 7], FUR.deer);
      blob(ctx, 0, -9, [5], shade(FUR.deer, 0.16));
      rect(ctx, -1, -6, 6, 1, FUR.deerPale);
      rect(ctx, -6, -11, 1, 3, FUR.deerPale); // tail up
      rect(ctx, 4, -12, 2, 4, FUR.deer); // neck, thrown forward
      rect(ctx, 5, -13, 4, 2, FUR.deer);
      rect(ctx, 8, -12, 2, 1, FUR.deerDark);
      rect(ctx, 5, -14, 1, 1, FUR.deerDark);
      if (antlers) {
        rect(ctx, 6, -15, 1, 2, FUR.deerPale);
        rect(ctx, 8, -16, 1, 2, FUR.deerPale);
      }
      return;
    }

    // legs
    rect(ctx, -4, -4, 1, 4, FUR.deerDark);
    rect(ctx, -2, -4, 1, 4, FUR.deer);
    rect(ctx, 2, -4, 1, 4, FUR.deer);
    rect(ctx, 4, -4, 1, 4, FUR.deerDark);
    // barrel
    blob(ctx, 0, -9, [7, 9, 9, 8, 6], FUR.deer);
    blob(ctx, 0, -9, [5], shade(FUR.deer, 0.16));
    rect(ctx, -2, -5, 6, 1, FUR.deerPale);
    rect(ctx, -5, -9, 1, 2, FUR.deerPale); // tail

    if (pose === 0) {
      rect(ctx, 3, -12, 2, 4, FUR.deer); // neck
      rect(ctx, 4, -13, 4, 3, FUR.deer); // head
      rect(ctx, 7, -12, 2, 2, FUR.deerDark); // muzzle
      rect(ctx, 4, -14, 1, 1, FUR.deerDark); // ear
      rect(ctx, 6, -12, 1, 1, PAL.ink); // eye
      if (antlers) {
        rect(ctx, 5, -16, 1, 3, FUR.deerPale);
        rect(ctx, 7, -17, 1, 3, FUR.deerPale);
        rect(ctx, 6, -16, 1, 1, FUR.deerPale);
      }
    } else {
      rect(ctx, 3, -9, 2, 3, FUR.deer); // neck, dropped
      rect(ctx, 5, -6, 2, 3, FUR.deer);
      rect(ctx, 6, -4, 4, 3, FUR.deer); // head at the grass
      rect(ctx, 9, -3, 1, 2, FUR.deerDark);
      rect(ctx, 6, -5, 1, 1, FUR.deerDark); // ear
      if (antlers) {
        rect(ctx, 6, -8, 1, 3, FUR.deerPale);
        rect(ctx, 8, -8, 1, 2, FUR.deerPale);
      }
    }
  });
}

/** A small dog, two frames of a trot. Half a sheep tall, mostly tail. */
export function buildDog(pose: 0 | 1, faceRight: boolean): Sprite {
  return makeSprite(14, 14, 6, 11, (ctx) => {
    if (!faceRight) ctx.scale(-1, 1);
    poly(ctx, diamond(0, 1, 9), PAL.shadowSoft);
    const spread = pose === 0 ? 0 : 1;
    rect(ctx, -2 - spread, -3, 1, 3, FUR.dogDark);
    rect(ctx, 2 + spread, -3, 1, 3, FUR.dogPale);
    rect(ctx, -1, -3, 1, 3, FUR.dogDark);
    rect(ctx, 1, -3, 1, 3, FUR.dogPale);
    blob(ctx, 0, -7, [5, 7, 6], FUR.dog);
    rect(ctx, 1, -5, 4, 1, FUR.dogPale); // white chest and belly
    rect(ctx, 3, -9, 3, 3, FUR.dog); // head
    rect(ctx, 4, -9, 1, 3, FUR.dogPale); // blaze
    rect(ctx, 5, -8, 2, 1, FUR.dogPale); // snout
    rect(ctx, 3, -10, 1, 1, FUR.dogDark); // ear
    rect(ctx, 5, -9, 1, 1, PAL.ink); // eye
    rect(ctx, -4, -9 + pose, 1, 2, FUR.dog); // tail, wagging
    rect(ctx, -5, -10 + pose, 1, 1, FUR.dogPale); // …with a white tip
  });
}

/**
 * The same animal `buildSheep` draws, but with its facing and its head chosen
 * rather than rolled: a flock that actually moves needs to be able to turn
 * round and to put its head in the grass.
 */
export function buildGrazingSheep(seed: number, faceRight: boolean, grazing: boolean): Sprite {
  const rng = mulberry32(seed);
  const w = 10 + Math.round(rng() * 2);
  return makeSprite(18, 16, 9, 12, (ctx) => {
    if (!faceRight) ctx.scale(-1, 1);
    poly(ctx, diamond(1, 1, 12), PAL.shadowSoft);
    rect(ctx, -4, -3, 1, 3, PAL.ink);
    rect(ctx, 2, -3, 1, 3, PAL.ink);
    blob(ctx, 0, -9, [w - 3, w, w + 1, w, w - 2], '#f4efe6');
    blob(ctx, -1, -9, [4, 5], '#ffffff');
    if (grazing) {
      rect(ctx, 4, -5, 3, 3, '#4c4658');
      rect(ctx, 4, -6, 2, 1, '#4c4658');
    } else {
      rect(ctx, 5, -9, 3, 3, '#4c4658');
    }
  });
}

/** A fish clearing the water, tilted by whether it is still rising. */
export function drawFishJump(ctx: Ctx, x: number, y: number, vy: number): void {
  const px = Math.round(x);
  const py = Math.round(y);
  const tilt = vy < 0 ? -1 : 1;
  ctx.fillStyle = FUR.fish;
  ctx.fillRect(px - 2, py, 4, 2);
  ctx.fillStyle = PAL.stoneLight;
  ctx.fillRect(px - 1, py, 2, 1);
  ctx.fillStyle = FUR.fishDark;
  ctx.fillRect(px - 4, py + tilt, 2, 1);
  ctx.fillStyle = PAL.ink;
  ctx.fillRect(px + 1, py, 1, 1);
}

/**
 * The ring a jump leaves behind: a dozen pixels on an isometric ellipse, so it
 * lies down on the water the way a tile does.
 */
export function drawRipple(ctx: Ctx, x: number, y: number, r: number, alpha: number): void {
  if (alpha <= 0.02 || r <= 0) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = PAL.waterFoam;
  const n = 10 + Math.round(r);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ctx.fillRect(Math.round(x + Math.cos(a) * r), Math.round(y + Math.sin(a) * r * 0.5), 1, 1);
  }
  ctx.globalAlpha = prev;
}
