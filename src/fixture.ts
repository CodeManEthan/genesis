/**
 * Genesis — hand-written development fixture.
 *
 * A tiny, fully hand-authored world plus a hand-authored day, written against
 * the `types.ts` contract so the renderer and the player UI can be built and
 * screenshotted before `gen.ts` / `timeline.ts` exist.
 *
 * It also carries a reference implementation of the three snapshot functions
 * that `timeline.ts` owes the renderer (`emptySnapshot`, `snapshotAt`,
 * `advance`). Those are what `TheGenesis.tsx` calls through its `loadWorld`
 * helper, so swapping in the generated world is a one-line change there.
 *
 * Nothing in this file touches the DOM, `Date` or `Math.random`.
 */

import type {
  BuildMaterial,
  BuildingSpec,
  Chunk,
  GenesisEvent,
  GenesisMap,
  LakeSpec,
  OutcropSpec,
  PropSpec,
  RoofStyle,
  SiteSpec,
  StructureRole,
  Timeline,
  TreeKind,
  TreeSpec,
  Vec2,
  WorldSnapshot,
} from './types';

/** Screen-aligned authoring: u runs right, v runs down. */
const P = (u: number, v: number): Vec2 => [(v + u) / 2, (v - u) / 2];

const MINT = '#63c9a8';
const ROSE = '#e98fc3';

/* --------------------------------- chunks -------------------------------- */

const BIOMES = [
  ['forest', 'forest', 'meadow', 'meadow'],
  ['forest', 'meadow', 'meadow', 'farm'],
  ['meadow', 'wetland', 'meadow', 'farm'],
  ['meadow', 'meadow', 'farm', 'farm'],
] as const;

function makeChunks(): Chunk[] {
  const out: Chunk[] = [];
  const u0 = -40;
  const v0 = -4;
  const du = 20;
  const dv = 17;
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      out.push({
        id: `c${i}_${j}`,
        u0: u0 + i * du,
        v0: v0 + j * dv,
        u1: u0 + (i + 1) * du,
        v1: v0 + (j + 1) * dv,
        biome: BIOMES[j][i],
        seed: 1000 + j * 17 + i * 3,
      });
    }
  }
  return out;
}

/* -------------------------------- buildings ------------------------------ */

interface B {
  id: string;
  u: number;
  v: number;
  role: StructureRole;
  label: string;
  w: number;
  floors: 1 | 2 | 3;
  roof: RoofStyle;
  chimney?: boolean;
  awning?: boolean;
  banner?: boolean;
  cupola?: boolean;
  clears?: string[];
}

function building(
  siteId: string,
  accent: string,
  b: B,
  seed: number,
  material?: BuildMaterial
): BuildingSpec {
  const [gx, gy] = P(b.u, b.v);
  return {
    id: b.id,
    siteId,
    gx,
    gy,
    role: b.role,
    label: b.label,
    w: b.w,
    floors: b.floors,
    // A stone town never thatches, exactly as in gen.ts.
    roof: material === 'stone' && b.roof === 'thatch' ? 'gable' : b.roof,
    chimney: !!b.chimney,
    awning: !!b.awning,
    banner: !!b.banner,
    cupola: !!b.cupola,
    accent,
    seed,
    clears: b.clears ?? [],
    ...(material ? { material } : null),
  };
}

const S0_BUILDINGS: B[] = [
  {
    id: 's0-b0',
    u: -14,
    v: 30,
    role: 'homestead',
    label: 'The First House',
    w: 32,
    floors: 1,
    roof: 'thatch',
    chimney: true,
    clears: [],
  },
  {
    id: 's0-b1',
    u: -21,
    v: 27,
    role: 'cottage',
    label: 'Rowan Cottage',
    w: 28,
    floors: 1,
    roof: 'gable',
    chimney: true,
    clears: ['tr01'],
  },
  {
    id: 's0-b2',
    u: -8,
    v: 34.5,
    role: 'barn',
    label: 'The Long Barn',
    w: 36,
    floors: 1,
    roof: 'gable',
    clears: ['tr02', 'tr03'],
  },
  {
    id: 's0-b3',
    u: -2,
    v: 27,
    role: 'mill',
    label: 'Watermill',
    w: 32,
    floors: 2,
    roof: 'hip',
    chimney: true,
    banner: true,
    clears: ['tr05'],
  },
];

const S1_BUILDINGS: B[] = [
  {
    id: 's1-b0',
    u: 16,
    v: 22,
    role: 'hall',
    label: 'Moot Hall',
    w: 40,
    floors: 2,
    roof: 'hip',
    chimney: true,
    banner: true,
    clears: ['tr09'],
  },
  {
    id: 's1-b1',
    u: 22.5,
    v: 25.5,
    role: 'smithy',
    label: 'The Smithy',
    w: 32,
    floors: 1,
    roof: 'gable',
    chimney: true,
    awning: true,
    clears: ['tr10', 'tr11'],
  },
  {
    id: 's1-b2',
    u: 10.5,
    v: 19,
    role: 'chapel',
    label: 'Wayside Chapel',
    w: 28,
    floors: 1,
    roof: 'gable',
    cupola: true,
    clears: [],
  },
];

/* --------------------------------- props --------------------------------- */

function prop(id: string, kind: string, u: number, v: number, seed: number): PropSpec {
  const [gx, gy] = P(u, v);
  return { id, kind, gx, gy, seed };
}

const S0_PROPS: PropSpec[] = [
  prop('s0-well', 'well', -12, 32, 11),
  prop('s0-nameboard', 'nameboard', -10.5, 26.5, 12),
  prop('s0-crop', 'crop', -19, 33.5, 13),
  prop('s0-haystack', 'haystack', -22, 33, 14),
  prop('s0-lamp', 'lamp', -11, 28.5, 15),
  prop('s0-cart', 'cart', -16.5, 29, 16),
  prop('s0-sheep', 'sheep', -24, 31, 17),
];

const S1_PROPS: PropSpec[] = [
  prop('s1-nameboard', 'nameboard', 12.5, 24, 21),
  prop('s1-well', 'well', 18.5, 24.5, 22),
  prop('s1-crates', 'crates', 24, 23, 23),
  prop('s1-lamp', 'lamp', 13.5, 21, 24),
  prop('s1-crop', 'crop', 20, 29, 25),
  prop('s1-barrels', 'barrels', 25, 24.5, 26),
];

/* --------------------------------- trees --------------------------------- */

const TREES: [string, TreeKind, number, number][] = [
  // plot clearances
  ['tr01', 'oak', -21.5, 25.5],
  ['tr02', 'oak', -9.5, 36],
  ['tr03', 'pine', -6, 34],
  ['tr05', 'oak', -3.5, 28.8],
  ['tr09', 'blossom', 17.5, 23.6],
  ['tr10', 'oak', 23.5, 27],
  ['tr11', 'pine', 21, 27.4],
  // west woodland
  ['tr20', 'pine', -34, 12],
  ['tr21', 'pine', -30, 15],
  ['tr22', 'oak', -33, 20],
  ['tr23', 'pine', -27, 10],
  ['tr24', 'oak', -24, 17],
  ['tr25', 'hedgerow', -30, 24],
  ['tr26', 'oak', -35, 28],
  ['tr27', 'pine', -28, 34],
  ['tr28', 'blossom', -24, 40],
  ['tr29', 'oak', -18, 44],
  ['tr30', 'hedgerow', -12, 41],
  // east woodland
  ['tr31', 'pine', 26, 12],
  ['tr32', 'oak', 30, 16],
  ['tr33', 'pine', 33, 22],
  ['tr34', 'oak', 28, 31],
  ['tr35', 'hedgerow', 22, 36],
  ['tr36', 'blossom', 16, 33],
  ['tr37', 'oak', 34, 34],
  ['tr38', 'pine', 12, 44],
  ['tr39', 'oak', 6, 40],
  ['tr40', 'hedgerow', -2, 45],
  ['tr41', 'pine', 8, 10],
  ['tr42', 'oak', -6, 12],
  ['tr43', 'blossom', -14, 16],
  ['tr44', 'pine', 18, 8],
];

/* -------------------------------- scatter -------------------------------- */

const SCATTER: [string, string, number, number][] = [
  ['pr01', 'rock', -26, 27],
  ['pr02', 'bush', -20, 20],
  ['pr03', 'flowers', -17, 36],
  ['pr04', 'rock', 20, 17],
  ['pr05', 'bush', 27, 26],
  ['pr06', 'flowers', 10, 30],
  ['pr07', 'reeds', 4, 18],
  ['pr08', 'reeds', 0.5, 30],
  ['pr09', 'reeds', 3, 40],
  ['pr10', 'reeds', 1, 12],
  ['pr11', 'stump', -8, 22],
  ['pr12', 'rock', 6, 46],
  ['pr13', 'bush', -30, 38],
  ['pr14', 'flowers', 30, 40],
  ['pr15', 'sheep', -26, 36],
  ['pr16', 'sheep', -28, 37.5],
  ['pr17', 'bush', 14, 14],
  ['pr18', 'rock', -36, 16],
  ['pr19', 'flowers', 24, 44],
  ['pr20', 'bush', -4, 38],
];

/* ----------------------------- water and rock ---------------------------- */

/**
 * A hand-authored lake, built the same way gen.ts builds one: an ellipse in
 * u/v with a low-order radial wobble on it, resolved to a closed outline. The
 * renderer only ever reads `pts` (and scales it about gx/gy), so this is the
 * whole contract — but the analytic fields are carried too, exactly as the
 * generator carries them, so a test written against either one works here.
 */
function lake(
  id: string,
  u: number,
  v: number,
  rx: number,
  ry: number,
  rot: number,
  fed: boolean,
  seed: number
): LakeSpec {
  const w1 = 0.13;
  const w2 = 0.06;
  const p1 = 0.7;
  const p2 = 2.3;
  const pts: Vec2[] = [];
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const k = 1 + w1 * Math.sin(3 * a + p1) + w2 * Math.sin(5 * a + p2);
    const x = Math.cos(a) * rx * k;
    const y = Math.sin(a) * ry * k;
    pts.push(P(u + x * Math.cos(rot) - y * Math.sin(rot), v + x * Math.sin(rot) + y * Math.cos(rot)));
  }
  const [gx, gy] = P(u, v);
  return { id, gx, gy, rx, ry, rot, seed, fed, pts };
}

function outcrop(id: string, u: number, v: number, radius: number, seed: number): OutcropSpec {
  const [gx, gy] = P(u, v);
  return { id, gx, gy, radius, seed };
}

/** Boulders for the outcrop, and reeds/rocks round the shore. */
const LAKE_SHORE: [string, string, number, number][] = [
  ['pr30', 'reeds', -32, 8.5],
  ['pr31', 'reeds', -27.5, 6],
  ['pr32', 'rock', -22.5, 9],
  ['pr33', 'reeds', -24, 14.5],
  ['pr34', 'bush', -29, 16],
  ['pr35', 'reeds', -33.5, 13],
  ['pr36', 'flowers', -34.5, 11],
];
const ROCK_FIELD: [string, string, number, number][] = [
  ['pr40', 'rock', 30, 18],
  ['pr41', 'rock', 32, 20.5],
  ['pr42', 'rock', 28.5, 20],
  ['pr43', 'rock', 31, 16],
  ['pr44', 'bush', 33, 18.5],
  ['pr45', 'rock', 29, 22.5],
  ['pr46', 'stump', 33.5, 21.5],
];

/* ---------------------------------- map ---------------------------------- */

/**
 * The fixture world.
 *
 * `lakes` and `quarry` are knobs rather than fixtures because the two features
 * they turn on are precisely the ones with no hand-written world to fall back
 * on: `fixtureMap({ lakes: false, quarry: false })` is the pre-lake valley, so
 * a renderer bug can be bisected against it exactly the way `USE_GENERATED`
 * bisects a generation bug against the whole file.
 */
export function fixtureMap(opts: { lakes?: boolean; quarry?: boolean } = {}): GenesisMap {
  const withLakes = opts.lakes ?? true;
  const withQuarry = opts.quarry ?? true;
  const s0: SiteSpec = {
    id: 's0',
    name: 'Hollowmere',
    gx: P(-14, 30)[0],
    gy: P(-14, 30)[1],
    radius: 8,
    accent: MINT,
    buildings: S0_BUILDINGS.map((b, i) => building('s0', MINT, b, 300 + i * 7)),
    props: S0_PROPS,
  };
  const s1: SiteSpec = {
    id: 's1',
    name: 'Brightwold',
    gx: P(16, 22)[0],
    gy: P(16, 22)[1],
    radius: 7,
    accent: ROSE,
    // Brightwold quarries the outcrop on the east ridge, so it builds in stone.
    buildings: S1_BUILDINGS.map((b, i) =>
      building('s1', ROSE, b, 700 + i * 11, withQuarry ? 'stone' : undefined)
    ),
    props: withQuarry
      ? [...S1_PROPS, prop('s1-quarry0', 'quarry-blocks', 24.5, 20, 27), prop('s1-crane', 'crane', 22, 18.5, 28)]
      : S1_PROPS,
  };

  return {
    version: 1,
    seed: 7,
    bounds: { u0: -40, v0: -4, u1: 40, v1: 64 },
    content: { u0: -30, v0: 8, u1: 32, v1: 46 },
    chunks: makeChunks(),
    river: [P(2, -4), P(0, 8), P(3, 20), P(1, 32), P(4, 46), P(2, 64)],
    riverWidth: 0.95,
    lakes: withLakes ? [lake('lk0', -28.5, 11.5, 4.2, 2.8, 0.4, false, 4321)] : [],
    outcrops: withQuarry ? [outcrop('oc0', 31, 19.5, 3.2, 8765)] : [],
    sites: [s0, s1],
    roads: [
      {
        id: 'r0',
        kind: 'highway',
        width: 0.62,
        from: 's0',
        to: 's1',
        pts: [
          P(-14, 30),
          P(-10, 28.5),
          P(-5, 26.5),
          P(0, 25),
          P(2.6, 24.2),
          P(8, 23),
          P(13, 22.4),
          P(16, 22),
        ],
      },
    ],
    bridges: [{ id: 'br0', roadId: 'r0', gx: P(2.6, 24.2)[0], gy: P(2.6, 24.2)[1], span: 4.4 }],
    trees: TREES.map(([id, kind, u, v], i) => {
      const [gx, gy] = P(u, v);
      return { id, kind, gx, gy, seed: 5000 + i * 13 } as TreeSpec;
    }),
    scatter: [
      ...SCATTER.map(([id, kind, u, v], i) => prop(id, kind, u, v, 9000 + i * 17)),
      ...(withLakes ? LAKE_SHORE.map(([id, kind, u, v], i) => prop(id, kind, u, v, 9500 + i * 17)) : []),
      ...(withQuarry ? ROCK_FIELD.map(([id, kind, u, v], i) => prop(id, kind, u, v, 9700 + i * 17)) : []),
    ],
    valleyName: 'Amberdown',
  };
}

/* -------------------------------- timeline ------------------------------- */

/** A hand-authored day: every event type, roughly one beat every 25 minutes. */
export function fixtureTimeline(map: GenesisMap): Timeline {
  const e: GenesisEvent[] = [
    { t: 0.4, type: 'log', text: 'First light. One chimney, one kettle.', siteId: 's0' },
    { t: 0.9, type: 'chop-start', treeId: 'tr01' },
    { t: 1.4, type: 'chop-done', treeId: 'tr01' },
    { t: 1.5, type: 'survey', buildingId: 's0-b1' },
    { t: 1.6, type: 'log', text: 'Rowan Cottage is staked out west of the house.', siteId: 's0' },
    { t: 2.0, type: 'build', buildingId: 's0-b1', progress: 0.3 },
    { t: 2.6, type: 'build', buildingId: 's0-b1', progress: 0.55 },
    { t: 3.1, type: 'build', buildingId: 's0-b1', progress: 0.82 },
    { t: 3.5, type: 'build', buildingId: 's0-b1', progress: 1 },
    { t: 3.55, type: 'log', text: 'Rowan Cottage is finished.', siteId: 's0' },
    { t: 3.8, type: 'arrive', siteId: 's0', n: 2 },
    { t: 3.85, type: 'log', text: 'Two more settlers walk in off the moor.', siteId: 's0' },
    { t: 4.2, type: 'prop', propId: 's0-well', siteId: 's0' },
    { t: 4.4, type: 'prop', propId: 's0-nameboard', siteId: 's0' },
    { t: 4.5, type: 'log', text: 'A board goes up: HOLLOWMERE.', siteId: 's0' },
    { t: 4.8, type: 'road', roadId: 'r0', frac: 0.1 },
    { t: 5.0, type: 'chop-start', treeId: 'tr02' },
    { t: 5.1, type: 'chop-start', treeId: 'tr03' },
    { t: 5.7, type: 'chop-done', treeId: 'tr02' },
    { t: 6.0, type: 'survey', buildingId: 's0-b2' },
    { t: 6.4, type: 'chop-done', treeId: 'tr03' },
    { t: 6.6, type: 'build', buildingId: 's0-b2', progress: 0.28 },
    { t: 7.2, type: 'road', roadId: 'r0', frac: 0.24 },
    { t: 7.6, type: 'build', buildingId: 's0-b2', progress: 0.52 },
    { t: 8.0, type: 'prop', propId: 's0-cart', siteId: 's0' },
    { t: 8.4, type: 'build', buildingId: 's0-b2', progress: 0.78 },
    { t: 8.9, type: 'build', buildingId: 's0-b2', progress: 1 },
    { t: 8.95, type: 'log', text: 'The Long Barn takes its roof.', siteId: 's0' },
    { t: 9.2, type: 'arrive', siteId: 's0', n: 3 },
    { t: 9.6, type: 'prop', propId: 's0-crop', siteId: 's0' },
    { t: 9.7, type: 'prop', propId: 's0-haystack', siteId: 's0' },
    { t: 10.0, type: 'chop-start', treeId: 'tr05' },
    { t: 10.2, type: 'road', roadId: 'r0', frac: 0.36 },
    { t: 10.6, type: 'chop-done', treeId: 'tr05' },
    { t: 10.8, type: 'bridge', bridgeId: 'br0', stage: 1 },
    { t: 10.9, type: 'log', text: 'Pilings go into the ford.', siteId: 's0' },
    { t: 11.2, type: 'survey', buildingId: 's0-b3' },
    { t: 11.6, type: 'bridge', bridgeId: 'br0', stage: 2 },
    { t: 11.9, type: 'build', buildingId: 's0-b3', progress: 0.3 },
    { t: 12.2, type: 'bridge', bridgeId: 'br0', stage: 3 },
    { t: 12.3, type: 'log', text: 'The bridge is open. The far bank is reachable.' },
    { t: 12.6, type: 'road', roadId: 'r0', frac: 0.56 },
    { t: 13.0, type: 'build', buildingId: 's0-b3', progress: 0.6 },
    { t: 13.4, type: 'found', siteId: 's1', text: 'Brightwold is founded on the east ridge.' },
    { t: 13.8, type: 'arrive', siteId: 's1', n: 2 },
    { t: 14.0, type: 'chop-start', treeId: 'tr09' },
    { t: 14.2, type: 'prop', propId: 's1-nameboard', siteId: 's1' },
    { t: 14.6, type: 'chop-done', treeId: 'tr09' },
    { t: 14.8, type: 'survey', buildingId: 's1-b0' },
    { t: 15.0, type: 'build', buildingId: 's0-b3', progress: 0.88 },
    { t: 15.4, type: 'build', buildingId: 's1-b0', progress: 0.26 },
    { t: 15.7, type: 'build', buildingId: 's0-b3', progress: 1 },
    { t: 15.75, type: 'log', text: 'The watermill turns for the first time.', siteId: 's0' },
    { t: 16.1, type: 'road', roadId: 'r0', frac: 0.74 },
    { t: 16.5, type: 'build', buildingId: 's1-b0', progress: 0.55 },
    { t: 16.9, type: 'prop', propId: 's0-lamp', siteId: 's0' },
    { t: 17.3, type: 'chop-start', treeId: 'tr10' },
    { t: 17.5, type: 'chop-start', treeId: 'tr11' },
    { t: 17.8, type: 'build', buildingId: 's1-b0', progress: 0.84 },
    { t: 18.1, type: 'chop-done', treeId: 'tr10' },
    { t: 18.3, type: 'chop-done', treeId: 'tr11' },
    { t: 18.5, type: 'build', buildingId: 's1-b0', progress: 1 },
    { t: 18.55, type: 'log', text: 'Moot Hall is raised. A banner goes up.', siteId: 's1' },
    { t: 18.8, type: 'road', roadId: 'r0', frac: 1 },
    { t: 18.9, type: 'log', text: 'The highway between the two towns is finished.' },
    { t: 19.2, type: 'arrive', siteId: 's1', n: 3 },
    { t: 19.5, type: 'survey', buildingId: 's1-b1' },
    { t: 19.9, type: 'prop', propId: 's1-well', siteId: 's1' },
    { t: 20.2, type: 'build', buildingId: 's1-b1', progress: 0.34 },
    { t: 20.8, type: 'build', buildingId: 's1-b1', progress: 0.66 },
    { t: 21.1, type: 'prop', propId: 's1-crates', siteId: 's1' },
    { t: 21.4, type: 'build', buildingId: 's1-b1', progress: 1 },
    { t: 21.45, type: 'log', text: 'The forge is lit at Brightwold.', siteId: 's1' },
    { t: 21.8, type: 'survey', buildingId: 's1-b2' },
    { t: 22.1, type: 'prop', propId: 's1-crop', siteId: 's1' },
    { t: 22.4, type: 'build', buildingId: 's1-b2', progress: 0.45 },
    { t: 22.8, type: 'arrive', siteId: 's0', n: 2 },
    { t: 23.0, type: 'build', buildingId: 's1-b2', progress: 0.8 },
    { t: 23.3, type: 'build', buildingId: 's1-b2', progress: 1 },
    { t: 23.4, type: 'prop', propId: 's1-lamp', siteId: 's1' },
    { t: 23.5, type: 'prop', propId: 's1-barrels', siteId: 's1' },
    { t: 23.6, type: 'prop', propId: 's0-sheep', siteId: 's0' },
    { t: 23.8, type: 'log', text: 'Lamps lit in both towns. The day closes.' },
  ];
  // Anything the map dresses a town with that the script above does not name —
  // the quarry yard, for one — still has to appear, or it would sit in the map
  // and never be drawn. They go up through the middle of the afternoon, in
  // array order, which is the order the contract says dressing appears in.
  {
    const scheduled = new Set(e.filter((x) => x.type === 'prop').map((x) => x.propId));
    const extra: { propId: string; siteId: string }[] = [];
    for (const s of map.sites) {
      for (const p of s.props) {
        if (!scheduled.has(p.id)) extra.push({ propId: p.id, siteId: s.id });
      }
    }
    extra.forEach((x, i) => {
      e.push({ t: 12 + ((i + 1) / (extra.length + 1)) * 6, type: 'prop', ...x });
    });
  }
  e.sort((a, b) => a.t - b.t);
  return { events: e };
}

/* ---------------------- reference snapshot evaluator --------------------- */
/* Mirrors what timeline.ts must export; swapped out by `loadWorld`.         */

export function fixtureEmptySnapshot(map: GenesisMap): WorldSnapshot {
  const buildings: WorldSnapshot['buildings'] = new Map();
  for (const s of map.sites) {
    for (const b of s.buildings) buildings.set(b.id, { status: 'unplanned', progress: 0 });
  }
  const first = map.sites[0];
  const founded = new Set<string>();
  const population = new Map<string, number>();
  const log: { t: number; text: string }[] = [];
  if (first) {
    founded.add(first.id);
    population.set(first.id, 2);
    if (first.buildings[0]) buildings.set(first.buildings[0].id, { status: 'done', progress: 1 });
    log.push({ t: 0, text: `A house stands alone in ${map.valleyName}.` });
  }
  return {
    t: 0,
    trees: new Map(),
    buildings,
    roads: new Map(),
    bridges: new Map(),
    props: new Set(),
    founded,
    population,
    log,
  };
}

/** Forward-only. Applies every event in (snap.t, toT]. */
export function fixtureAdvance(snap: WorldSnapshot, tl: Timeline, toT: number): void {
  if (toT <= snap.t) {
    snap.t = toT;
    return;
  }
  for (const ev of tl.events) {
    if (ev.t <= snap.t) continue;
    if (ev.t > toT) break;
    applyEvent(snap, ev);
  }
  snap.t = toT;
}

export function fixtureSnapshotAt(map: GenesisMap, tl: Timeline, t: number): WorldSnapshot {
  const snap = fixtureEmptySnapshot(map);
  fixtureAdvance(snap, tl, t);
  return snap;
}

function applyEvent(snap: WorldSnapshot, ev: GenesisEvent): void {
  switch (ev.type) {
    case 'found':
      snap.founded.add(ev.siteId);
      if (!snap.population.has(ev.siteId)) snap.population.set(ev.siteId, 1);
      snap.log.push({ t: ev.t, text: ev.text });
      break;
    case 'arrive':
      snap.population.set(ev.siteId, (snap.population.get(ev.siteId) ?? 0) + ev.n);
      break;
    case 'chop-start':
      snap.trees.set(ev.treeId, 'felling');
      break;
    case 'chop-done':
      snap.trees.set(ev.treeId, 'stump');
      break;
    case 'survey':
      snap.buildings.set(ev.buildingId, { status: 'surveyed', progress: 0.05 });
      break;
    case 'build':
      snap.buildings.set(ev.buildingId, {
        status: ev.progress >= 1 ? 'done' : 'building',
        progress: Math.min(1, ev.progress),
      });
      break;
    case 'road':
      snap.roads.set(ev.roadId, Math.max(snap.roads.get(ev.roadId) ?? 0, ev.frac));
      break;
    case 'bridge':
      snap.bridges.set(ev.bridgeId, ev.stage);
      break;
    case 'prop':
      snap.props.add(ev.propId);
      break;
    case 'log':
      snap.log.push({ t: ev.t, text: ev.text });
      break;
  }
}
