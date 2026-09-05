// Genesis play harness.
//
// The founder's walk is a pure function of (map, snapshot, held keys per
// tick), and the input log is the changes in those keys. This checks the
// property the link depends on: a walk recorded live, encoded for a URL,
// decoded and replayed from the doorstep lands the founder on the same tile
// to the last bit. It also pins the codec's edges — truncation, garbage,
// foreign entries, the cap — since every one of them is a link somebody will
// paste.
//
// Output is deterministic and part of `npm run check`: a changed line means
// the walk changed.
//
// Usage: node scripts/play-stats.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gdir = join(root, 'src');

const { hashSeed } = await import(join(gdir, 'types.ts'));
const { generateMap } = await import(join(gdir, 'gen.ts'));
const { buildTimeline, snapshotAt } = await import(join(gdir, 'timeline.ts'));
const {
  AVATAR_ROAD_SPEED,
  AVATAR_SPEED,
  MASK_DOWN,
  MASK_LEFT,
  MASK_RIGHT,
  MASK_UP,
  NO_INPUT,
  TICK_DT,
  WALK_LOG_MAX,
  createAvatar,
  decodePlayLog,
  decodeWalk,
  encodePlayLog,
  encodeWalk,
  footingAt,
  packInput,
  presenceAt,
  recordInput,
  replayWalk,
  stepAvatar,
  unpackInput,
} = await import(join(gdir, 'play.ts'));

let failed = 0;
let total = 0;
const f4 = (x) => x.toFixed(4);

function check(label, fails) {
  total++;
  if (fails.length) {
    failed++;
    console.log(`FAIL ${label}`);
    for (const m of fails) console.log(`  - ${m}`);
  } else console.log(`ok   ${label}`);
}

/**
 * A scripted hand on the keys: runs of (ticks held, mask). Long enough to
 * cross ground, meet a wall or two and turn, and to include both a diagonal
 * and a dead stop. The same script drives every seed.
 */
const SCRIPT = [
  [90, MASK_RIGHT],
  [60, MASK_RIGHT | MASK_DOWN],
  [30, 0],
  [150, MASK_LEFT],
  [200, MASK_UP],
  [45, MASK_DOWN],
  [80, MASK_RIGHT | MASK_UP],
  [25, MASK_LEFT | MASK_DOWN],
  [40, 0],
  [120, MASK_DOWN],
];

/** Drive the avatar live, recording the way the island does. */
function drive(map, snap, script) {
  const av = createAvatar(map, snap);
  const log = [];
  let offFooting = 0;
  let path = 0;
  for (const [ticks, mask] of script) {
    const input = unpackInput(mask);
    for (let k = 0; k < ticks; k++) {
      const [x0, y0] = [av.gx, av.gy];
      recordInput(log, av.tick + 1, input);
      stepAvatar(map, snap, av, input);
      path += Math.hypot(av.gx - x0, av.gy - y0);
      if (!footingAt(map, snap, av.gx, av.gy).walkable) offFooting++;
    }
  }
  return { av, log, offFooting, path };
}

const same = (a, b) =>
  a.gx === b.gx &&
  a.gy === b.gy &&
  a.tick === b.tick &&
  a.still === b.still &&
  a.faceRight === b.faceRight &&
  a.phase === b.phase &&
  a.moving === b.moving &&
  a.lu === b.lu &&
  a.lv === b.lv;

const describe = (a) => `(${f4(a.gx)}, ${f4(a.gy)}) tick ${a.tick} ${a.faceRight ? 'R' : 'L'}`;

/* -------------------------------------------------------------------------- */
/* a recorded walk replays                                                    */
/* -------------------------------------------------------------------------- */

const SEEDS = [['2026-09-04', hashSeed('2026-09-04')], ['42', 42], ['20260802', 20260802]];

console.log('play — the walk and its log');
for (const [label, seed] of SEEDS) {
  const map = generateMap(seed);
  const tl = buildTimeline(map);
  const snap = snapshotAt(map, tl, 11);
  const fails = [];

  const start = createAvatar(map, snap);
  if (!footingAt(map, snap, start.gx, start.gy).walkable) fails.push('doorstep is not walkable');

  const live = drive(map, snap, SCRIPT);
  if (live.offFooting) fails.push(`stood on unwalkable ground on ${live.offFooting} ticks`);
  if (live.path < 3) fails.push(`the script barely moved the founder: ${f4(live.path)} tiles walked`);

  const expectTicks = SCRIPT.reduce((n, [t]) => n + t, 0);
  if (live.av.tick !== expectTicks) fails.push(`live tick ${live.av.tick} != ${expectTicks}`);

  // One entry per change of mask, none for a held key, none for idle at start.
  const changes = SCRIPT.filter(([, m], i) => (i === 0 ? m !== 0 : m !== SCRIPT[i - 1][1])).length;
  if (live.log.length !== changes) fails.push(`log has ${live.log.length} entries, expected ${changes}`);

  // Through the link and back.
  const url = encodePlayLog({ walk: { log: live.log, end: live.av.tick } });
  if (!/^[0-9A-Za-z*.]*$/.test(url)) fails.push(`encoded log is not address-bar safe: ${url}`);
  const back = decodePlayLog(url);
  if (JSON.stringify(back.walk.log) !== JSON.stringify(live.log)) fails.push('log did not survive the codec');
  if (back.walk.end !== live.av.tick) fails.push(`end ${back.walk.end} != live tick ${live.av.tick}`);

  const replayed = replayWalk(map, snap, back.walk.log, back.walk.end);
  if (!same(replayed, live.av)) fails.push(`replay ${describe(replayed)} != live ${describe(live.av)}`);

  // Replaying twice is the same walk; determinism has no memory.
  if (!same(replayWalk(map, snap, back.walk.log, back.walk.end), replayed)) fails.push('two replays differ');

  // Without the end, the walk stops at its last change — earlier, since the
  // script holds its last key to the end — and that is still a legal walk.
  const cut = replayWalk(map, snap, back.walk.log);
  if (cut.tick !== live.log[live.log.length - 1].tick) fails.push('replay without an end did not stop at the last change');

  // Idle ticks after the last change move nothing.
  const idle = replayWalk(map, snap, back.walk.log, back.walk.end);
  for (let k = 0; k < 100; k++) stepAvatar(map, snap, idle, NO_INPUT);
  if (idle.gx !== replayed.gx || idle.gy !== replayed.gy) fails.push('idle ticks moved the founder');
  if (idle.moving) fails.push('idle founder reports moving');
  if (Math.abs(idle.still - 100 * TICK_DT) > 1e-9) fails.push(`still after 100 idle ticks is ${idle.still}`);
  stepAvatar(map, snap, idle, unpackInput(MASK_DOWN));
  if (idle.still !== 0) fails.push('a step did not reset still');

  // Recording onto a replayed log carries on from where it left off.
  const cont = [...back.walk.log];
  const before = cont.length;
  recordInput(cont, idle.tick + 1, unpackInput(MASK_LEFT));
  if (cont.length !== before + 1 || cont[cont.length - 1].tick !== idle.tick + 1) {
    fails.push('recording after a replay did not append at the next tick');
  }

  const pres = presenceAt(map, snap, replayed);
  console.log(
    `  seed ${label}: ${describe(live.av)} · ${f4(live.path)} tiles walked · ${live.log.length} changes · ?log=${url} · ${
      pres ? pres.key : 'no presence'
    }`
  );
  check(`seed ${label}: the walk replays from its log`, fails);
}

/* -------------------------------------------------------------------------- */
/* the ground                                                                 */
/* -------------------------------------------------------------------------- */

{
  const map = generateMap(42);
  const tl = buildTimeline(map);
  const snap = snapshotAt(map, tl, 11);
  const fails = [];

  // Hold one direction for a long time in each of the four: the founder never
  // ends up in water or in a wall, and at least one way is open.
  const reach = [];
  for (const mask of [MASK_UP, MASK_DOWN, MASK_LEFT, MASK_RIGHT]) {
    const r = drive(map, snap, [[3000, mask]]);
    if (r.offFooting) fails.push(`mask ${mask}: ${r.offFooting} ticks on unwalkable ground`);
    const start = createAvatar(map, snap);
    reach.push(Math.hypot(r.av.gx - start.gx, r.av.gy - start.gy));
  }
  if (Math.max(...reach) < 5) fails.push(`no direction goes anywhere: ${reach.map(f4).join(' ')}`);
  console.log(`  reach after 50s held: ${reach.map(f4).join(' ')} tiles`);

  // Speeds are what the module says they are, per tick.
  const av = createAvatar(map, snap);
  const foot = footingAt(map, snap, av.gx, av.gy);
  const g0 = [av.gx, av.gy];
  stepAvatar(map, snap, av, unpackInput(MASK_RIGHT));
  const d = Math.hypot(av.gx - g0[0], av.gy - g0[1]);
  const expect = foot.speed * TICK_DT;
  if (Math.abs(d - expect) > 1e-9 && d !== 0) fails.push(`one tick moved ${d}, footing says ${expect}`);
  if (!(AVATAR_ROAD_SPEED > AVATAR_SPEED)) fails.push('a road is not faster than open ground');

  check('the ground holds the founder up, and only where it should', fails);
}

/* -------------------------------------------------------------------------- */
/* the deck is a strip, and the ledger knows the terrain                     */
/* -------------------------------------------------------------------------- */

/** The river's tangent and normal at a crossing, the way the renderer finds them. */
function axisAt(map, gx, gy) {
  let bi = 0;
  let bd = Infinity;
  const seg = (px, py, a, b) => {
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    let t = ((px - a[0]) * vx + (py - a[1]) * vy) / (vx * vx + vy * vy || 1);
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - a[0] - vx * t, py - a[1] - vy * t);
  };
  for (let i = 0; i + 1 < map.river.length; i++) {
    const d = seg(gx, gy, map.river[i], map.river[i + 1]);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  const tx = map.river[bi + 1][0] - map.river[bi][0];
  const ty = map.river[bi + 1][1] - map.river[bi][1];
  const l = Math.hypot(tx, ty) || 1;
  return { tx: tx / l, ty: ty / l, nx: -ty / l, ny: tx / l };
}

{
  // Seed 1 has a bridge and a ford; the bridge is decked by late evening.
  const map = generateMap(1);
  const tl = buildTimeline(map);
  const snap = snapshotAt(map, tl, 23.5);
  const fails = [];
  const walk = (x, y) => footingAt(map, snap, x, y).walkable;

  for (const [kind, list, depth] of [
    ['bridge', map.bridges, 1.15],
    ['ford', map.fords ?? [], 1.5],
  ]) {
    for (const c of list) {
      if (kind === 'bridge' && (snap.bridges.get(c.id) ?? 0) < 2) {
        fails.push(`${c.id} not decked at 23:30`);
        continue;
      }
      const ax = axisAt(map, c.gx, c.gy);
      const at = (along, across) => [c.gx + ax.nx * along + ax.tx * across, c.gy + ax.ny * along + ax.ty * across];
      const f = footingAt(map, snap, c.gx, c.gy);
      if (!f.walkable) fails.push(`${c.id}: the middle of the deck is not walkable`);
      if (kind === 'bridge' && f.bridgeId !== c.id) fails.push(`${c.id}: middle is not on the bridge`);
      if (kind === 'ford' && f.fordId !== c.id) fails.push(`${c.id}: middle is not in the ford`);
      // Along the deck to either end: on it.
      for (const k of [-1, 1]) {
        const [x, y] = at(k * c.span * 0.5, 0);
        if (!walk(x, y)) fails.push(`${c.id}: the end of the deck (${k}) is not walkable`);
      }
      // Beside the deck, out in the current: water. The old disc said yes here.
      for (const k of [-1, 1]) {
        const [x, y] = at(0, k * (depth + 0.6));
        const off = footingAt(map, snap, x, y);
        if (off.walkable) fails.push(`${c.id}: ${(depth + 0.6).toFixed(2)} tiles ${k > 0 ? 'down' : 'up'}stream of the deck is walkable`);
        if (off.bridgeId || off.fordId) fails.push(`${c.id}: off the deck still counts as the crossing`);
      }
      // Well past the end: whatever the bank is, not the crossing.
      const [ex, ey] = at(c.span * 0.5 + 1.4, 0);
      const past = footingAt(map, snap, ex, ey);
      if (past.bridgeId === c.id || past.fordId === c.id) fails.push(`${c.id}: 1.4 tiles past the end still counts as the deck`);
      console.log(`  ${c.id}: span ${c.span.toFixed(2)}, deck strip ${(c.span + 1.2).toFixed(2)} × ${(depth * 2).toFixed(2)} tiles`);
    }
  }
  check('a crossing is a strip across the water, not a disc of it', fails);
}

{
  const fails = [];
  const lines = [];
  const at = (map, snap, gx, gy) => {
    const av = createAvatar(map, snap);
    av.gx = gx;
    av.gy = gy;
    av.footing = footingAt(map, snap, gx, gy);
    return presenceAt(map, snap, av);
  };
  const expect = (label, p, key) => {
    if (!p) fails.push(`${label}: no presence`);
    else if (!p.key.startsWith(key)) fails.push(`${label}: key ${p.key}, expected ${key}…`);
    else lines.push(`  ${p.key}: ${p.text}`);
  };

  // Seed 1: stones, a ruin, an outcrop.
  {
    const map = generateMap(1);
    const snap = snapshotAt(map, buildTimeline(map), 11);
    const st = map.stones[0];
    expect('stones', at(map, snap, st.gx, st.gy), `stones-${st.id}`);
    const ru = map.ruins[0];
    expect('ruin', at(map, snap, ru.gx, ru.gy), `ruin-${ru.id}`);
    const oc = map.outcrops[0];
    expect('outcrop', at(map, snap, oc.gx, oc.gy), `outcrop-${oc.id}`);
  }
  // Seed 4: a ferry, run by s0 once s0 is founded, and a circle with a fallen stone.
  {
    const map = generateMap(4);
    const tl = buildTimeline(map);
    const fy = map.ferry;
    if (!fy) fails.push('seed 4 has no ferry');
    else {
      const early = snapshotAt(map, tl, 0);
      const late = snapshotAt(map, tl, 23);
      // The near stage is in the first town, which is founded at t=0, so the
      // ferry is never idle here; only the far stage at midnight is pinned.
      expect('ferry, near stage', at(map, early, fy.ax, fy.ay), `ferry-${fy.id}`);
      expect('ferry, far stage', at(map, late, fy.bx, fy.by), `ferry-${fy.id}-run`);
    }
    const st = map.stones[0];
    expect('circle', at(map, snapshotAt(map, tl, 11), st.gx, st.gy), `stones-${st.id}`);
    const ru = map.ruins[0];
    expect('corner', at(map, snapshotAt(map, tl, 11), ru.gx, ru.gy), `ruin-${ru.id}`);
  }
  for (const l of lines) console.log(l);
  check('the ledger has a line for the ferry, the stones, a ruin and the rock', fails);
}

/* -------------------------------------------------------------------------- */
/* the codec's edges                                                          */
/* -------------------------------------------------------------------------- */

{
  const fails = [];
  const eq = (a, b, msg) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${msg}: ${JSON.stringify(a)}`);
  };

  eq(packInput(NO_INPUT), 0, 'NO_INPUT packs to 0');
  for (let m = 0; m < 16; m++) eq(packInput(unpackInput(m)), m, `mask ${m} round trip`);

  const none = { log: [], end: 0 };
  eq(encodeWalk([]), '', 'empty walk encodes empty');
  eq(encodePlayLog({ walk: none }), '', 'empty log encodes empty');
  eq(decodeWalk(''), none, 'empty decodes empty');
  eq(decodeWalk(null), none, 'null decodes empty');
  eq(decodePlayLog(undefined).walk, none, 'undefined log decodes empty');
  eq(encodeWalk([], 0), '', 'an empty walk with no ticks is nothing');
  eq(encodeWalk([], 50), '.1e', 'an empty walk with ticks is only its end');
  eq(decodeWalk('.1e'), { log: [], end: 50 }, 'and comes back as one');

  const walk = [
    { tick: 1, mask: 8 },
    { tick: 93, mask: 0 },
    { tick: 100, mask: 15 },
  ];
  const W = (n, end = walk[n - 1].tick) => ({ log: walk.slice(0, n), end });
  eq(encodeWalk(walk), '1I2kA7P', 'the documented example encodes as documented');
  eq(decodeWalk('1I2kA7P'), W(3), 'and decodes back');
  eq(encodeWalk(walk, 100), '1I2kA7P', 'an end at the last change is not written');
  eq(encodeWalk(walk, 192), '1I2kA7P.2k', 'an end past it is');
  eq(decodeWalk('1I2kA7P.2k'), W(3, 192), 'and comes back');
  eq(encodePlayLog({ walk: W(3, 192) }), 'w1I2kA7P.2k', 'the log is the walk entry alone');

  // Truncated by an address bar: the prefix that parses.
  eq(decodeWalk('1I2kA7'), W(2), 'truncated mid-entry keeps the prefix');
  eq(decodeWalk('1I2k'), W(1), 'truncated at the gap keeps the prefix');
  eq(decodeWalk('1I2kA7P.'), W(3), 'a bare end marker is no end');
  eq(decodeWalk('1I2kA7P.2'), W(3, 102), 'a truncated end is a shorter walk');
  // Hand-edited into nonsense: nothing, never a throw.
  eq(decodeWalk('!!!'), none, 'garbage decodes empty');
  eq(decodeWalk('0A1I'), none, 'a zero gap stops the parse');
  eq(decodeWalk('1I1Q'), W(1), 'a mask past P stops the parse');
  eq(decodeWalk('1I.0'), W(1), 'a zero end gap is no end');
  // A stranger's verbs beside the walk, and a walk beside a stranger's verbs.
  eq(decodePlayLog('f9.50-tr412*w1I2kA7P').walk, W(3), 'foreign entry first is skipped');
  eq(decodePlayLog('w1I2kA7P*f9.50-tr412').walk, W(3), 'foreign entry last is skipped');
  eq(decodePlayLog('w1I*w2A').walk, W(1), 'a second walk entry is ignored');
  eq(decodePlayLog('*').walk, none, 'a bare separator is nothing');

  // The recorder: no entry for an unchanged mask, none for an idle start.
  const log = [];
  eq(recordInput(log, 1, NO_INPUT), false, 'idle at the start is not news');
  eq(recordInput(log, 2, unpackInput(8)), true, 'a key down is');
  eq(recordInput(log, 3, unpackInput(8)), false, 'holding it is not');
  eq(recordInput(log, 2, unpackInput(0)), false, 'a change on a tick already recorded is refused');
  eq(recordInput(log, 4, unpackInput(0)), true, 'letting go is');
  eq(log, [{ tick: 2, mask: 8 }, { tick: 4, mask: 0 }], 'recorder log');

  // The cap: a wild hand that changes keys every tick for far too long.
  const wild = [];
  for (let t = 1; t <= WALK_LOG_MAX + 500; t++) wild.push({ tick: t, mask: (t % 15) + 1 });
  const capped = decodeWalk(encodeWalk(wild, wild.length + 1000));
  eq(capped.log.length, WALK_LOG_MAX, 'the encoder keeps WALK_LOG_MAX changes');
  eq(capped.log, wild.slice(0, WALK_LOG_MAX), 'and they are the first ones');
  eq(capped.end, WALK_LOG_MAX, 'and a capped walk ends at its last kept change');
  const encodedLen = encodeWalk(wild).length;
  if (encodedLen > 4200) fails.push(`a full log is ${encodedLen} chars, more than a URL should carry`);
  console.log(`  a full log: ${WALK_LOG_MAX} changes in ${encodedLen} chars`);

  // A large gap: a founder who stood still for an hour of ticks.
  const long = [{ tick: 1, mask: 1 }, { tick: 216001, mask: 0 }];
  eq(decodeWalk(encodeWalk(long)), { log: long, end: 216001 }, 'an hour-long gap round trips');

  check('the codec: round trips, truncation, garbage, strangers, the cap', fails);
}

console.log(`\n${failed ? `${failed}/${total} PLAY CASES FAILED` : `all ${total} play cases PASS`}`);
process.exit(failed ? 1 : 0);
