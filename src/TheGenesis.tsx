/**
 * Genesis — the island.
 *
 * A world is generated from the day's seed, born at midnight and finished by
 * the following midnight. This file owns three things and nothing else:
 *
 *   the world clock   LIVE pins `t` to the visitor's wall clock; PLAYER
 *                     detaches it so it can be paused, sped up and scrubbed.
 *   the camera        drag to pan, wheel through a short fixed zoom ladder,
 *                     Fit to frame the valley.
 *   the chrome        transport bar, scrubber, clock readout and the ledger
 *                     ticker in the corner.
 *
 * Snapshot discipline, straight off the contract: moving *forward* is
 * `advance` (cheap, incremental); any jump *backwards* is a full `snapshotAt`
 * recompute, after which the ambient layer is thrown away and re-seeded.
 *
 * `prefers-reduced-motion` drops the rAF loop entirely: the world is settled
 * once and repainted only when something actually changes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { TH, TW, hashSeed, type GenesisMap, type Timeline, type WorldSnapshot } from './types';
import { dayInfo } from './daytype.ts';
import {
  buildGenesisScene,
  makeAmbient,
  renderGenesis,
  resetAmbient,
  setAmbientPace,
  settleAmbient,
  stepAmbient,
  syncAmbient,
  type Ambient,
  type GenesisScene,
} from './scene';
import {
  fixtureAdvance,
  fixtureEmptySnapshot,
  fixtureMap,
  fixtureSnapshotAt,
  fixtureTimeline,
} from './fixture';

/* ------------------------------ world loading ---------------------------- */

/**
 * Everything the island needs, in one bundle. `gen.ts` and `timeline.ts` are
 * written against the same contract, so wiring them up is entirely contained in
 * `loadWorld` below.
 */
export interface World {
  map: GenesisMap;
  timeline: Timeline;
  emptySnapshot: (map: GenesisMap) => WorldSnapshot;
  snapshotAt: (map: GenesisMap, tl: Timeline, t: number) => WorldSnapshot;
  advance: (snap: WorldSnapshot, tl: Timeline, toT: number) => void;
}

/* ========================= INTEGRATION SWITCH ============================= *
 * The only place the island knows where a world comes from.
 *
 *   USE_GENERATED = true   gen.ts + timeline.ts — the real seeded world.
 *   USE_GENERATED = false  fixture.ts — the hand-written development harness
 *                          the renderer was built against. Flip to this to
 *                          isolate a rendering bug from a generation bug.
 * ------------------------------------------------------------------------- */
import { generateMap } from './gen';
import { advance, buildTimeline, emptySnapshot, snapshotAt } from './timeline';

const USE_GENERATED = true;

/**
 * `pace` is how ambitious the day is, so it belongs to the *map*: a bigger pace
 * generates more of the valley. The timeline then paces whatever it is handed
 * across the same 24 hours, which is why nothing here passes it along.
 */
function loadWorld(seed: number, pace = 1): World {
  if (USE_GENERATED) {
    const map = generateMap(seed, pace);
    return {
      map,
      timeline: buildTimeline(map),
      emptySnapshot,
      snapshotAt,
      advance,
    };
  }
  // The fixture is one hand-written valley; there is no more of it to build.
  const map = fixtureMap();
  map.seed = seed;
  return {
    map,
    timeline: fixtureTimeline(map),
    emptySnapshot: fixtureEmptySnapshot,
    snapshotAt: fixtureSnapshotAt,
    advance: fixtureAdvance,
  };
}

/* --------------------------------- helpers ------------------------------- */

const SPEEDS = [60, 600, 3600];
/** How much the valley builds today, which is a different question from how
 * fast the clock runs. The day is always a day; at 4 it simply fills with four
 * times the settlement, and at ½ it stays a hamlet. */
const PACES = [0.5, 1, 2, 4];
const PACE_LABELS = ['½', '1', '2', '4'];
const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);
const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/** Nearest rung of the pace ladder to an arbitrary `?pace=`. */
function paceIndex(p: number): number {
  let best = 1;
  for (let i = 0; i < PACES.length; i++) {
    if (Math.abs(PACES[i] - p) < Math.abs(PACES[best] - p)) best = i;
  }
  return best;
}

/**
 * A cheap identity for "what the ticker is currently showing".
 *
 * The ledger is capped, so once a busy day passes the cap its *length* stops
 * changing while new lines keep arriving — length alone would silently freeze
 * the ticker for the rest of the day. The last entry, on the other hand, is
 * new every time something is appended, and the ticker only ever shows the
 * tail, so this is exactly as sensitive as the display is.
 */
function logSig(log: { t: number; text: string }[]): string {
  const last = log[log.length - 1];
  return last ? `${log.length}|${last.t}|${last.text}` : '0';
}
/** Never equal to any real signature: forces the next push through. */
const LOG_FORCE = '!';

/**
 * Pixel art has to be drawn at the *panel's* resolution. Size the backing store
 * in CSS pixels instead and a 3× phone renders the whole valley into a third of
 * the pixels it owns — the detail is decimated away before the browser scales
 * the finished frame back up, and what smoothing the upscale adds softens what
 * little survived. That is exactly what Genesis used to look like on a phone.
 *
 * Capped at 3: past that the frame costs ratio² more fill for a difference no
 * eye can find, and phones that report 4 are the ones least able to afford it.
 */
const MAX_DPR = 3;
const deviceRatio = () => Math.min(Math.max(1, window.devicePixelRatio || 1), MAX_DPR);

const randomSeed = () => Math.floor(Math.random() * 4294967296) >>> 0;
const stepSeed = (seed: number, d: 1 | -1) => ((seed + d + 4294967296) % 4294967296) >>> 0;

function fmtClock(t: number): string {
  const c = clamp(t, 0, 23.9999);
  const h = Math.floor(c);
  const m = Math.floor((c - h) * 60);
  return `${pad2(h)}:${pad2(m)}`;
}

function wallClockHours(): number {
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

/**
 * The date that hands out the day's seed. Deliberately *local*, because the
 * world clock above is local: the valley has to be born at the visitor's own
 * midnight, or LIVE would roll the day over hours away from the seed changing.
 */
function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const daySeed = (d?: Date) => hashSeed(dayKey(d));

/**
 * Which month a seed belongs to, or null if it belongs to no date at all.
 *
 * This is the one place that knows whether a seed came out of the calendar, and
 * it is the only thing the season needs: a LIVE world — and the one waiting on
 * the other side of midnight — is in the season the visitor is actually in,
 * while a browsed seed has no month and derives a season of its own, so ‹ and ›
 * walk through the year as well as through the valleys.
 */
function monthOfSeed(seed: number): number | null {
  const now = new Date();
  for (let k = -1; k <= 1; k++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + k, 12);
    if (daySeed(d) === seed) return d.getMonth() + 1;
  }
  return null;
}

/** What kind of day this seed is, and what time of year. */
const dayFor = (seed: number) => dayInfo(seed, monthOfSeed(seed));

/** Tomorrow's seed, for pre-generating the world the clock is about to reach. */
function nextDaySeed(): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return daySeed(d);
}

interface Cam {
  cx: number;
  cy: number;
  zoom: number;
}

/* ------------------------------- component ------------------------------- */

export interface GenesisProps {
  /**
   * The island is sitting in a page that scrolls. Vertical wheel and space/arrow
   * keys then belong to the document, not the map: zoom moves behind ctrl/⌘ (the
   * gesture every web map uses), the keyboard transport only answers once focus
   * is actually inside the world, and the seed browser starts folded away so it
   * cannot argue with the page's own copy.
   */
  embed?: boolean;
}

export default function TheGenesis({ embed = false }: GenesisProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /** CSS box of the wrapper, plus the display ratio it is being drawn at: a
   * change to either one has to rebuild the canvas backing store. */
  const [size, setSize] = useState<{ w: number; h: number; dpr: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<'live' | 'player'>('live');
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(1);
  const [tDisp, setTDisp] = useState(0);
  const [valley, setValley] = useState('');
  const [seed, setSeed] = useState(0);
  const [paceIdx, setPaceIdx] = useState(1);
  const [lines, setLines] = useState<{ t: number; text: string }[]>([]);
  /** The seed browser is a lab tool: open where the lab page is the whole
   * screen, folded behind the valley's own name where the world is a hero. */
  const [worldOpen, setWorldOpen] = useState(!embed);
  /**
   * Only ever consulted on a phone. A screen that small is nearly all world, so
   * the transport folds down into a single chip and the valley gets the band it
   * was drawn for; the wide layout below 620px ignores this entirely and keeps
   * the bar where it has always been.
   */
  const [barOpen, setBarOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const foldRef = useRef<HTMLButtonElement | null>(null);

  /** The seed the date hands out; "Today" is whatever this is. Moves on by
   * itself when a LIVE world rolls over into the next day. */
  const todayRef = useRef(0);
  if (!todayRef.current) todayRef.current = daySeed();

  const worldRef = useRef<World | null>(null);
  const sceneRef = useRef<GenesisScene | null>(null);
  const ambRef = useRef<Ambient | null>(null);
  const snapRef = useRef<WorldSnapshot | null>(null);
  const tRef = useRef(0);
  const modeRef = useRef<'live' | 'player'>('live');
  const playingRef = useRef(false);
  const speedRef = useRef(SPEEDS[1]);
  const camRef = useRef<Cam | null>(null);
  const ladderRef = useRef<number[]>([1]);
  const dirtyRef = useRef(true);
  const reducedRef = useRef(false);
  /** Identity of the ledger's last line, so "is there anything new?" survives
   * the log's own cap. See `logSig` below. */
  const logSigRef = useRef('');
  const seedRef = useRef(0);
  const paceRef = useRef(1);

  const api = useRef<{
    applyT: (t: number) => void;
    paint: () => void;
    fit: () => void;
    stepZoom: (dir: 1 | -1, ax?: number, ay?: number) => void;
    pan: (dx: number, dy: number) => void;
    chooseSeed: (seed: number) => void;
    choosePace: (pace: number) => void;
  } | null>(null);

  /** Worlds stay shareable: the address bar always describes what is on screen,
   * and says nothing it does not have to. */
  const syncUrl = useCallback(
    (nextSeed: number, nextPace: number, newMap: boolean, dropT = false) => {
      const url = new URL(window.location.href);
      const q = url.searchParams;
      // A rolled-over day has left its deep-linked hour far behind; keeping it
      // would make a reload of this URL show something else entirely.
      //
      // Otherwise the hour is in the address bar exactly when it is a decision:
      // a *held* moment is a framing worth sharing, so it is written down.
      // LIVE and playback are not moments at all — they keep the URL clean, and
      // a link to them opens on the visitor's own clock.
      if (dropT) q.delete('t');
      else if (modeRef.current === 'player' && !playingRef.current) {
        q.set('t', clamp(tRef.current, 0, 24).toFixed(1));
      } else q.delete('t');
      if (nextSeed === todayRef.current) q.delete('seed');
      else q.set('seed', String(nextSeed >>> 0));
      if (nextPace === 1) q.delete('pace');
      else q.set('pace', String(nextPace));
      // A different valley invalidates any hand-set camera in the URL.
      if (newMap) {
        q.delete('zoom');
        q.delete('cx');
        q.delete('cy');
      }
      const s = q.toString();
      window.history.replaceState(null, '', `${url.pathname}${s ? `?${s}` : ''}${url.hash}`);
    },
    []
  );

  /* ------------------------------- sizing ------------------------------- */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      const dpr = deviceRatio();
      setSize((prev) =>
        prev &&
        prev.dpr === dpr &&
        Math.abs(prev.w - r.width) < 1 &&
        Math.abs(prev.h - r.height) < 1
          ? prev
          : { w: Math.max(1, r.width), h: Math.max(1, r.height), dpr }
      );
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);

    // A window dragged onto a different monitor, or a browser zoom, changes the
    // ratio without changing the element's size at all, so the observer alone
    // would leave the canvas at the wrong resolution. The media query has to be
    // re-armed each time, because it only ever matches the ratio it was made for.
    let mq: MediaQueryList | null = null;
    function onRatio() {
      read();
      watchRatio();
    }
    function watchRatio() {
      mq?.removeEventListener?.('change', onRatio);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      // Old Safari has no listener on a MediaQueryList; it simply never hears
      // about a ratio change, which is the behaviour it had before any of this.
      mq.addEventListener?.('change', onRatio);
    }
    watchRatio();

    return () => {
      ro.disconnect();
      mq?.removeEventListener?.('change', onRatio);
    };
  }, []);

  /* --------------------------- world + the loop -------------------------- */
  useEffect(() => {
    if (!size || size.w < 2 || size.h < 2) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    reducedRef.current = reduced;

    /* ---- one-time world construction ---------------------------------- */
    if (!worldRef.current) {
      const q = new URLSearchParams(window.location.search);
      const qSeed = Number(q.get('seed'));
      const seed0 = q.has('seed') && isFinite(qSeed) ? qSeed >>> 0 : todayRef.current;
      const qPace = Number(q.get('pace'));
      const pace0 = PACES[q.has('pace') && isFinite(qPace) ? paceIndex(qPace) : 1];
      seedRef.current = seed0;
      paceRef.current = pace0;
      setSeed(seed0);
      setPaceIdx(paceIndex(pace0));
      const world = loadWorld(seed0, pace0);
      worldRef.current = world;
      setValley(world.map.valleyName);

      const qt = Number(q.get('t'));
      const detached = q.has('t') && isFinite(qt);
      // `?t=` is the deep link into a moment of the day: it starts detached and
      // held, so a shared link — or a screenshot — always shows that exact hour.
      const t0 = detached ? clamp(qt, 0, 24) : wallClockHours();
      tRef.current = t0;
      modeRef.current = detached ? 'player' : 'live';
      setMode(detached ? 'player' : 'live');
      setTDisp(t0);

      snapRef.current = world.snapshotAt(world.map, world.timeline, t0);
      sceneRef.current = buildGenesisScene(world.map, dayFor(seed0));
      ambRef.current = makeAmbient(pace0);
      settleAmbient(sceneRef.current, ambRef.current, snapRef.current);
      logSigRef.current = logSig(snapRef.current.log);
      setLines(snapRef.current.log.slice(-3));

      // Dev hooks for the screenshot harness: start the transport rolling at a
      // chosen speed so a capture can be taken mid-playback (or mid-midnight).
      const qSpeed = Number(q.get('speed'));
      if (q.has('speed') && isFinite(qSpeed)) {
        let best = 0;
        for (let i = 0; i < SPEEDS.length; i++) {
          if (Math.abs(SPEEDS[i] - qSpeed) < Math.abs(SPEEDS[best] - qSpeed)) best = i;
        }
        speedRef.current = SPEEDS[best];
        setSpeedIdx(best);
      }
      if (q.get('autoplay') === '1') {
        modeRef.current = 'player';
        setMode('player');
        playingRef.current = true;
        setPlaying(true);
      }
      setReady(true);
    }

    // Reassigned wholesale when the visitor picks a different valley, so
    // everything downstream keeps talking to the world that is on screen.
    let world = worldRef.current!;
    let scene = sceneRef.current!;
    let amb = ambRef.current!;

    // The viewport is `vw × vh` CSS pixels and `dw × dh` real ones. Every camera
    // number below stays in CSS pixels — that is what a pointer, a wheel and a
    // layout all speak — and only the render crosses over into device pixels.
    const dpr = size.dpr;
    const vw = Math.max(1, Math.round(size.w));
    const vh = Math.max(1, Math.round(size.h));
    const dw = Math.max(1, Math.round(vw * dpr));
    const dh = Math.max(1, Math.round(vh * dpr));
    canvas.width = dw;
    canvas.height = dh;
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;
    ctx.imageSmoothingEnabled = false;

    /**
     * Snap a wished-for zoom onto the device-pixel grid. At or above one device
     * pixel per world pixel the magnification has to be a whole number or the
     * blit resamples and the art softens; below it we are downsampling anyway,
     * and no whole number is available to snap to.
     *
     * At 1× this is the identity on every rung the ladder used to have, so a
     * desktop's zoom steps are untouched; at 3× it turns them into thirds.
     */
    const snapZoom = (z: number) => (z * dpr >= 1 ? Math.round(z * dpr) / dpr : z);

    /* ---- zoom ladder: fitted overview, then whole-pixel steps ---------- */
    // Both are derived from the *current* map, so a new valley reframes and
    // re-rungs the ladder without the effect having to run again.
    const fitCam = (): Cam => {
      const c = world.map.content;
      const contentW = Math.max(1, (c.u1 - c.u0) * (TW / 2));
      const contentH = Math.max(1, (c.v1 - c.v0) * (TH / 2));
      const raw = Math.min(vw / contentW, vh / contentH);
      // Above one *device* pixel per world pixel the art wants whole-number
      // magnification or the tile edges go uneven; below it, any scale is fine
      // because we are downsampling. On a 3× phone the fitted overview is
      // therefore a third of a CSS pixel per world pixel — exactly one panel
      // pixel — rather than the arbitrary fraction it used to be.
      const overview =
        raw * dpr >= 1 ? Math.floor(raw * dpr) / dpr : Math.max(0.24, raw);
      const ladder: number[] = [overview];
      for (const z of [0.5, 1, 2, 3, 4]) {
        const r = snapZoom(z);
        if (r > ladder[ladder.length - 1] * 1.15) ladder.push(r);
      }
      while (ladder.length < 4) ladder.push(snapZoom(ladder[ladder.length - 1] * 2));
      ladderRef.current = ladder;
      return {
        zoom: overview,
        cx: c.u0 * (TW / 2) + contentW / 2 - vw / overview / 2,
        cy: c.v0 * (TH / 2) + contentH / 2 - vh / overview / 2,
      };
    };
    const home = fitCam();

    const clampCam = (cam: Cam): Cam => {
      const PAD = 160;
      const wpx = vw / cam.zoom;
      const wpy = vh / cam.zoom;
      const lx = scene.x0 - PAD;
      const rx = scene.x1 + PAD;
      const ty = scene.y0 - PAD;
      const by = scene.y1 + PAD;
      cam.cx = wpx >= rx - lx ? (lx + rx) / 2 - wpx / 2 : clamp(cam.cx, lx, rx - wpx);
      cam.cy = wpy >= by - ty ? (ty + by) / 2 - wpy / 2 : clamp(cam.cy, ty, by - wpy);
      return cam;
    };

    if (!camRef.current) {
      camRef.current = home;
      // Dev-only camera params, used by the screenshot harness to inspect a
      // particular corner of the valley at a particular magnification.
      const q = new URLSearchParams(window.location.search);
      const qz = Number(q.get('zoom'));
      const qx = Number(q.get('cx'));
      const qy = Number(q.get('cy'));
      if (q.has('zoom') && qz > 0) camRef.current.zoom = snapZoom(qz);
      if (q.has('cx') && isFinite(qx)) camRef.current.cx = qx - vw / camRef.current.zoom / 2;
      if (q.has('cy') && isFinite(qy)) camRef.current.cy = qy - vh / camRef.current.zoom / 2;
    }
    clampCam(camRef.current);

    /* ---- clock ---------------------------------------------------------- */
    let clock = 8;

    const pushLog = () => {
      const snap = snapRef.current!;
      const sig = logSig(snap.log);
      if (sig === logSigRef.current) return;
      logSigRef.current = sig;
      setLines(snap.log.slice(-3));
    };

    const applyT = (next: number) => {
      const snap = snapRef.current!;
      const t = clamp(next, 0, 24);
      if (Math.abs(t - snap.t) < 1e-7) {
        tRef.current = t;
        return;
      }
      if (t < snap.t - 1e-7) {
        // Any step backwards is a full recompute; the contract promises it is
        // cheap, and it is the only way the derived state stays honest.
        snapRef.current = world.snapshotAt(world.map, world.timeline, t);
        resetAmbient(scene, amb, snapRef.current);
        logSigRef.current = LOG_FORCE;
      } else {
        world.advance(snap, world.timeline, t);
      }
      tRef.current = t;
      dirtyRef.current = true;
      pushLog();
    };

    /* ---- the world waiting on the other side of midnight ---------------- */
    /** Pre-built while the valley is already dark, so the swap costs nothing. */
    let pending: {
      seed: number;
      pace: number;
      world: World;
      scene: GenesisScene;
    } | null = null;

    const ensurePending = (s: number) => {
      if (pending && pending.seed === s && pending.pace === paceRef.current) return pending;
      const w = loadWorld(s, paceRef.current);
      pending = {
        seed: s,
        pace: paceRef.current,
        world: w,
        scene: buildGenesisScene(w.map, dayFor(s)),
      };
      return pending;
    };

    /** A new seed or a new pace both mean a new map, and a new map is a whole
     * new world: ledger, baked terrain, crowd and framing all go. The clock
     * does not — the visitor keeps their hour, and LIVE stays LIVE. */
    const rebuild = (s: number, p: number) => {
      seedRef.current = s;
      paceRef.current = p;
      pending = null;
      world = loadWorld(s, p);
      worldRef.current = world;
      scene = buildGenesisScene(world.map, dayFor(s));
      sceneRef.current = scene;
      setAmbientPace(amb, p);
      snapRef.current = world.snapshotAt(world.map, world.timeline, tRef.current);
      resetAmbient(scene, amb, snapRef.current);
      settleAmbient(scene, amb, snapRef.current);
      camRef.current = clampCam(fitCam());
      logSigRef.current = LOG_FORCE;
      pushLog();
      setSeed(s);
      setValley(world.map.valleyName);
      dirtyRef.current = true;
      paintOnce();
    };

    /**
     * Midnight. The day the visitor has been watching is over, and the valley
     * has been fading towards black since about 23:40, so the swap itself is
     * invisible: the map, timeline, bake and crowd are all replaced while there
     * is nothing to see, and the light comes back up on a single house.
     *
     * Which seed comes next is the one thing the two modes disagree about.
     * LIVE follows the calendar — the new local date hands out the new seed, and
     * "Today" moves with it. A browsed world just steps to seed + 1, which is
     * the same thing the › button does, and stops being today's world.
     */
    const roll = (nextSeed: number, carryT: number, live: boolean) => {
      const next = ensurePending(nextSeed);
      pending = null;
      world = next.world;
      worldRef.current = world;
      scene = next.scene;
      sceneRef.current = scene;
      seedRef.current = nextSeed;
      if (live) todayRef.current = nextSeed;

      tRef.current = clamp(carryT, 0, 24);
      snapRef.current = world.snapshotAt(world.map, world.timeline, tRef.current);
      resetAmbient(scene, amb, snapRef.current);
      settleAmbient(scene, amb, snapRef.current);
      camRef.current = clampCam(fitCam());

      // The ledger starts over: yesterday's closing line goes out with the
      // light, and the founding of the new valley fades in with the pre-dawn.
      logSigRef.current = LOG_FORCE;
      pushLog();
      setSeed(nextSeed);
      setValley(world.map.valleyName);
      setTDisp(tRef.current);
      syncUrl(nextSeed, paceRef.current, true, true);
      dirtyRef.current = true;
    };

    /** The seed the clock is heading towards. */
    const comingSeed = () =>
      modeRef.current === 'live' ? nextDaySeed() : stepSeed(seedRef.current, 1);

    api.current = {
      applyT,
      paint: () => {
        dirtyRef.current = true;
        if (reducedRef.current) paintOnce();
      },
      fit: () => {
        camRef.current = clampCam(fitCam());
        dirtyRef.current = true;
        if (reducedRef.current) paintOnce();
      },
      stepZoom: (dir, ax, ay) => {
        const cam = camRef.current!;
        const lad = ladderRef.current;
        let i = 0;
        for (let k = 0; k < lad.length; k++) if (lad[k] <= cam.zoom + 1e-4) i = k;
        const next = lad[clamp(i + dir, 0, lad.length - 1)];
        if (Math.abs(next - cam.zoom) < 1e-4) return;
        const px = ax ?? vw / 2;
        const py = ay ?? vh / 2;
        const wx = cam.cx + px / cam.zoom;
        const wy = cam.cy + py / cam.zoom;
        camRef.current = clampCam({
          zoom: next,
          cx: wx - px / next,
          cy: wy - py / next,
        });
        dirtyRef.current = true;
        if (reducedRef.current) paintOnce();
      },
      pan: (dx, dy) => {
        const cam = camRef.current!;
        cam.cx -= dx / cam.zoom;
        cam.cy -= dy / cam.zoom;
        clampCam(cam);
        dirtyRef.current = true;
        if (reducedRef.current) paintOnce();
      },
      chooseSeed: (nextSeed) => {
        const s = nextSeed >>> 0;
        if (s === seedRef.current) return;
        rebuild(s, paceRef.current);
      },
      // A bigger pace is a bigger valley, so it regenerates the map too. The
      // seed guarantees everything already on screen stays exactly where it is
      // and simply gains neighbours.
      choosePace: (nextPace) => {
        if (nextPace === paceRef.current) return;
        rebuild(seedRef.current, nextPace);
      },
    };

    /* ---- optional frame-time readout (`?perf=1`) ------------------------ */
    // console.error so the headless screenshot harness, which only relays
    // errors, picks it up.
    const perf = new URLSearchParams(window.location.search).get('perf') === '1';
    let pN = 0;
    let pSum = 0;
    let pMax = 0;

    function paintOnce() {
      const cam = camRef.current!;
      const t0 = perf ? performance.now() : 0;
      renderGenesis(ctx!, scene, amb, snapRef.current!, { ...cam, vw, vh, dpr }, clock);
      dirtyRef.current = false;
      if (!perf) return;
      const ms = performance.now() - t0;
      pSum += ms;
      pMax = Math.max(pMax, ms);
      if (++pN >= 120) {
        console.error(
          `PERF render avg ${(pSum / pN).toFixed(2)}ms max ${pMax.toFixed(2)}ms ` +
            `(${(1000 / (pSum / pN)).toFixed(0)} fps ceiling) zoom ${camRef.current!.zoom} ` +
            `dpr ${dpr} devscale ${(camRef.current!.zoom * dpr).toFixed(3)} ` +
            `t=${tRef.current.toFixed(2)} trees=${scene.map.trees.length}`
        );
        pN = 0;
        pSum = 0;
        pMax = 0;
      }
    }

    /* ---- the tick ------------------------------------------------------- */
    // Generation is ~25ms; doing it here, deep in the dark, keeps the boundary
    // itself free of any hitch at any playback speed.
    const PREGEN_AT = 23.5;
    let uiAccum = 0;
    const tick = (dt: number) => {
      const running = modeRef.current === 'live' || playingRef.current;
      if (modeRef.current === 'live') {
        const wall = wallClockHours();
        // The wall clock only ever runs forward, so a large step *backwards* is
        // the calendar turning over underneath us.
        if (wall < tRef.current - 12) roll(daySeed(), wall, true);
        else applyT(wall);
      } else if (playingRef.current) {
        const raw = tRef.current + (dt * speedRef.current) / 3600;
        if (raw >= 24) roll(stepSeed(seedRef.current, 1), raw - 24, false);
        else applyT(raw);
      }
      // A pre-built world is only worth its ~35MB of baked canvases while
      // midnight is actually coming. Scrub or pause back into the day and it is
      // dropped again; the next approach to 23:30 rebuilds it.
      if (tRef.current < PREGEN_AT) pending = null;
      else if (running) ensurePending(comingSeed());
      syncAmbient(scene, amb, snapRef.current!);
      if (running && !reducedRef.current) {
        clock += dt;
        stepAmbient(scene, amb, snapRef.current!, dt);
        dirtyRef.current = true;
      }
      uiAccum += dt;
      if (uiAccum > 0.12) {
        uiAccum = 0;
        // Half a world-minute is the finest the readout can show; anything
        // smaller is a React render nobody can see.
        setTDisp((prev) => (Math.abs(prev - tRef.current) > 0.008 ? tRef.current : prev));
      }
      if (dirtyRef.current) paintOnce();
    };

    paintOnce();

    let raf = 0;
    let timer = 0;
    if (reduced) {
      // No animation loop at all: a slow heartbeat keeps LIVE and playback
      // honest, and everything else repaints on demand.
      timer = window.setInterval(() => tick(0.25), 250);
    } else {
      let last = performance.now();
      const loop = (now: number) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        tick(dt);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (timer) window.clearInterval(timer);
    };
  }, [size]);

  /* -------------------------------- input -------------------------------- */
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    api.current?.pan(e.clientX - d.x, e.clientY - d.y);
    d.x = e.clientX;
    d.y = e.clientY;
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  }, []);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Embedded, a plain wheel is the visitor scrolling the page and the map
      // has no business swallowing it; ctrl/⌘ + wheel is the zoom gesture, and
      // it is also what a trackpad pinch arrives as.
      if (embed && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      api.current?.stepZoom(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ready, embed]);

  /* ------------------------------ transport ------------------------------ */
  const detach = useCallback(() => {
    modeRef.current = 'player';
    setMode('player');
  }, []);

  /** Dragging the scrubber fires a change per pixel; the address bar only has
   * to catch up once the hand comes to rest. */
  const momentTimer = useRef(0);
  const syncMoment = useCallback(() => {
    window.clearTimeout(momentTimer.current);
    momentTimer.current = window.setTimeout(
      () => syncUrl(seedRef.current, paceRef.current, false),
      220
    );
  }, [syncUrl]);
  useEffect(() => () => window.clearTimeout(momentTimer.current), []);

  const seek = useCallback(
    (t: number) => {
      detach();
      api.current?.applyT(t);
      setTDisp(clamp(t, 0, 24));
      api.current?.paint();
      syncMoment();
    },
    [detach, syncMoment]
  );

  const togglePlay = useCallback(() => {
    detach();
    playingRef.current = !playingRef.current;
    setPlaying(playingRef.current);
    api.current?.paint();
    syncMoment();
  }, [detach, syncMoment]);

  const cycleSpeed = useCallback(() => {
    setSpeedIdx((i) => {
      const n = (i + 1) % SPEEDS.length;
      speedRef.current = SPEEDS[n];
      return n;
    });
  }, []);

  /* -------------------------------- worlds ------------------------------- */
  const pickSeed = useCallback(
    (next: number) => {
      const s = next >>> 0;
      if (s === seedRef.current) return;
      api.current?.chooseSeed(s);
      syncUrl(s, paceRef.current, true);
    },
    [syncUrl]
  );

  const cyclePace = useCallback(() => {
    const n = (paceIndex(paceRef.current) + 1) % PACES.length;
    setPaceIdx(n);
    api.current?.choosePace(PACES[n]);
    // A different pace is a different map, so any hand-set camera is stale too.
    syncUrl(seedRef.current, PACES[n], true);
  }, [syncUrl]);

  /**
   * The disclosure swaps one control for the other, so whichever one the hand
   * (or the tab key) was on is about to stop existing: hand focus straight to
   * its counterpart. On a wide screen both are display:none — `offsetParent`
   * catches that — and nothing moves at all.
   */
  const showBar = useCallback((open: boolean) => {
    setBarOpen(open);
    requestAnimationFrame(() => {
      const el = open ? foldRef.current : chipRef.current;
      if (el && el.offsetParent !== null) el.focus();
    });
  }, []);

  const goLive = useCallback(() => {
    modeRef.current = 'live';
    setMode('live');
    playingRef.current = false;
    setPlaying(false);
    api.current?.applyT(wallClockHours());
    setTDisp(wallClockHours());
    api.current?.paint();
    // Back on the wall clock, so the deep-linked hour goes out of the URL.
    syncMoment();
  }, [syncMoment]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' && e.key === ' ') return;
      // On a scrolling page space and the arrows are the page's, right up until
      // the visitor has actually put focus inside the world.
      if (embed && !wrapRef.current?.contains(document.activeElement)) return;
      if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        seek(tRef.current - 0.25);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        seek(tRef.current + 0.25);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seek, embed]);

  const latest = lines.length ? lines[lines.length - 1].text : '';
  const pct = (clamp(tDisp, 0, 24) / 24) * 100;
  /** The dark either side of midnight: the ledger goes quiet with the valley. */
  const hush = tDisp >= 23.7 || tDisp < 0.25;

  return (
    <div
      className={`genesis${embed ? ' gen-embed' : ''}${barOpen ? ' gen-open' : ''}`}
      ref={wrapRef}
    >
      <style>{CSS}</style>
      <canvas
        ref={canvasRef}
        className="gen-canvas"
        // Embedded, the world is one stop on a page: it takes focus so the
        // transport keys have somewhere to belong before they fire.
        tabIndex={embed ? 0 : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        aria-label={`A pixel-art valley called ${valley}, ${
          mode === 'live' ? 'live at' : 'held at'
        } ${fmtClock(tDisp)} of its first day.`}
        role="img"
      />

      <div className={`gen-ticker${hush ? ' gen-hush' : ''}`} aria-hidden="true">
        {lines.map((l, i) => (
          <p key={`${l.t}-${l.text}`} data-age={lines.length - 1 - i}>
            <span className="gen-stamp">{fmtClock(l.t)}</span>
            {l.text}
          </p>
        ))}
      </div>
      <p className="gen-sr" aria-live="polite">
        {latest}
      </p>

      {/* One top-right column: zoom, then the valley's own nameplate, which is
          also the door to the seed browser. The top *left* is left clear for
          whatever page the world is embedded in wants to say. */}
      <div className="gen-corner">
        <div className="gen-zoom">
          <button type="button" onClick={() => api.current?.stepZoom(1)} aria-label="Zoom in">
            +
          </button>
          <button type="button" onClick={() => api.current?.stepZoom(-1)} aria-label="Zoom out">
            −
          </button>
          <button type="button" onClick={() => api.current?.fit()}>
            Fit
          </button>
        </div>

        <div className="gen-world" role="group" aria-label="Which valley">
          <button
            type="button"
            className={`gen-wid${worldOpen ? ' on' : ''}`}
            onClick={() => setWorldOpen((v) => !v)}
            aria-expanded={worldOpen}
            aria-label={`${valley || 'This valley'}, seed ${seed}. Browse other valleys`}
            title="Browse other valleys"
          >
            <b>{valley || '…'}</b>
            <span>· seed {seed}</span>
            <i aria-hidden="true">{worldOpen ? '▴' : '▾'}</i>
          </button>

          {worldOpen && (
            <div className="gen-wrow">
              <button
                type="button"
                className="gen-wshuffle"
                onClick={() => pickSeed(randomSeed())}
                title="Generate a valley from a random seed"
              >
                New valley
              </button>
              <button
                type="button"
                className="gen-wstep"
                onClick={() => pickSeed(stepSeed(seedRef.current, -1))}
                aria-label="Previous seed"
                title="Previous seed"
              >
                ‹
              </button>
              <button
                type="button"
                className="gen-wstep"
                onClick={() => pickSeed(stepSeed(seedRef.current, 1))}
                aria-label="Next seed"
                title="Next seed"
              >
                ›
              </button>
              <button
                type="button"
                className={`gen-wtoday${seed === todayRef.current ? ' on' : ''}`}
                onClick={() => pickSeed(todayRef.current)}
                aria-pressed={seed === todayRef.current}
                title="Back to the valley this date generates"
              >
                Today
              </button>
            </div>
          )}
        </div>

        {embed && (
          <p className="gen-hint" aria-hidden="true">
            drag to roam · ctrl + scroll to zoom
          </p>
        )}
      </div>

      {/* The folded transport, and the only chrome along the base of a phone:
          the hour, whether the world is on the wall clock, and a way back to
          the controls. A wide screen never sees it — the bar is always there. */}
      <button
        type="button"
        ref={chipRef}
        className={`gen-chip${mode === 'live' ? ' on' : ''}`}
        onClick={() => showBar(true)}
        aria-expanded={barOpen}
        aria-controls="gen-transport"
        aria-label={`${fmtClock(tDisp)}${
          mode === 'live' ? ', live' : ''
        } — show the world clock controls`}
      >
        <b aria-hidden="true">{fmtClock(tDisp)}</b>
        <span className="gen-chiplive" aria-hidden="true">
          LIVE
        </span>
        <i aria-hidden="true">▴</i>
      </button>

      <div className="gen-bar" id="gen-transport" role="group" aria-label="World clock">
        <button
          type="button"
          className="gen-ico"
          onClick={() => seek(0)}
          aria-label="Restart the day"
          title="Restart the day"
        >
          ⏮
        </button>
        <button
          type="button"
          className="gen-ico gen-play"
          onClick={togglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause (space)' : 'Play (space)'}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <button
          type="button"
          className="gen-speed"
          onClick={cycleSpeed}
          aria-label={`Speed: ${SPEEDS[speedIdx]} times`}
          title="Playback speed"
        >
          ×{SPEEDS[speedIdx]}
        </button>
        <button
          type="button"
          className="gen-pace"
          onClick={cyclePace}
          aria-label={`Ambition: ${PACE_LABELS[paceIdx]}× as much valley built today`}
          title="Ambition — how much the valley builds today"
        >
          <span className="gen-plab" aria-hidden="true">
            pace
          </span>
          <b aria-hidden="true">{PACE_LABELS[paceIdx]}×</b>
        </button>

        <div className="gen-scrub">
          <div className="gen-track" aria-hidden="true">
            <div className="gen-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="gen-knob" aria-hidden="true" style={{ left: `${pct}%` }} />
          <input
            type="range"
            min={0}
            max={24}
            step={0.05}
            value={clamp(tDisp, 0, 24)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="World time in hours"
            aria-valuetext={`${fmtClock(tDisp)}`}
          />
        </div>

        <span className="gen-clock">
          <span className="gen-day">Day of {valley || '…'}</span>
          <b>{fmtClock(tDisp)}</b>
        </span>

        <button
          type="button"
          className={`gen-live${mode === 'live' ? ' on' : ''}`}
          onClick={goLive}
          aria-pressed={mode === 'live'}
          title="Follow the wall clock"
        >
          LIVE
        </button>

        <button
          type="button"
          ref={foldRef}
          className="gen-ico gen-fold"
          onClick={() => showBar(false)}
          aria-label="Hide the world clock controls"
          title="Hide the controls"
        >
          ▾
        </button>
      </div>
    </div>
  );
}

/* --------------------------------- styles -------------------------------- */

const CSS = `
.genesis {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #3f7f66;
  color: #413a55;
  font-family: system-ui, sans-serif;
  /* Vertical page scrolling always wins on touch; horizontal drags roam. */
  touch-action: pan-y;
}
.gen-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  image-rendering: pixelated;
  outline: none;
}
.gen-canvas:active { cursor: grabbing; }
.gen-canvas:focus-visible { box-shadow: inset 0 0 0 3px rgba(99, 201, 168, 0.85); }

.gen-bar {
  position: absolute;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 999px;
  background: rgba(253, 248, 239, 0.94);
  border: 1px solid rgba(65, 58, 85, 0.14);
  box-shadow: 0 8px 26px rgba(31, 28, 45, 0.28);
  backdrop-filter: blur(6px);
  max-width: min(760px, calc(100% - 32px));
}
.gen-bar button {
  font: inherit;
  color: #413a55;
  background: rgba(99, 201, 168, 0.14);
  border: 1px solid rgba(65, 58, 85, 0.12);
  border-radius: 999px;
  cursor: pointer;
  line-height: 1;
  transition: background 0.15s ease, color 0.15s ease;
}
.gen-bar button:hover { background: rgba(99, 201, 168, 0.32); }
.gen-ico { width: 32px; height: 32px; font-size: 0.8rem; }
.gen-play { background: #63c9a8; }
.gen-speed {
  height: 32px;
  padding: 0 10px;
  font-variant-numeric: tabular-nums;
  font-size: 0.82rem;
}
/* Work pace is not playback speed, so it does not look like it: warmer fill,
   a standing label, and the multiplier the other way round. */
.gen-pace {
  height: 32px;
  padding: 0 9px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  background: rgba(240, 199, 94, 0.26);
  border-color: rgba(160, 120, 24, 0.28) !important;
}
.gen-bar button.gen-pace:hover { background: rgba(240, 199, 94, 0.5); }
.gen-plab {
  font-size: 0.5rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  opacity: 0.6;
}
.gen-pace b { font-size: 0.8rem; font-variant-numeric: tabular-nums; }

.gen-scrub { position: relative; flex: 1 1 200px; min-width: 120px; height: 32px; }
.gen-track {
  position: absolute;
  inset: 50% 0 auto 0;
  transform: translateY(-50%);
  height: 8px;
  border-radius: 999px;
  background: rgba(65, 58, 85, 0.14);
  overflow: hidden;
}
.gen-fill { height: 100%; background: linear-gradient(90deg, #63c9a8, #8ad9bd); }
.gen-scrub input {
  position: absolute;
  inset: 0;
  width: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.gen-knob {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  margin-left: -6px;
  border-radius: 50%;
  background: #fdf8ef;
  border: 2px solid #2f9e7d;
  transform: translateY(-50%);
  pointer-events: none;
}
.gen-clock {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
  font-size: 0.72rem;
  white-space: nowrap;
}
.gen-clock .gen-day { opacity: 0.6; }
.gen-clock b { font-size: 0.98rem; font-variant-numeric: tabular-nums; }
.gen-live {
  height: 32px;
  padding: 0 12px;
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  font-weight: 700;
}
.gen-live.on { background: #63c9a8; color: #17301f; }

/* Both halves of the phone disclosure sit idle on a wide screen: the bar is
   simply always open there, so neither the chip nor its fold button exists. */
.gen-chip, .gen-fold { display: none; }

.gen-corner {
  position: absolute;
  right: 16px;
  top: 16px;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
.gen-zoom {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.gen-zoom button {
  font: inherit;
  font-size: 0.78rem;
  width: 34px;
  height: 30px;
  border-radius: 9px;
  color: #413a55;
  background: rgba(253, 248, 239, 0.92);
  border: 1px solid rgba(65, 58, 85, 0.14);
  cursor: pointer;
  box-shadow: 0 3px 10px rgba(31, 28, 45, 0.2);
}
.gen-zoom button:hover { background: #fff; }

.gen-world {
  display: flex;
  flex-direction: column;
  gap: 5px;
  align-items: flex-end;
}
.gen-wrow {
  display: flex;
  gap: 5px;
  padding: 5px;
  border-radius: 10px;
  background: rgba(253, 248, 239, 0.92);
  border: 1px solid rgba(65, 58, 85, 0.14);
  box-shadow: 0 3px 10px rgba(31, 28, 45, 0.2);
}
.gen-world button {
  font: inherit;
  font-size: 0.72rem;
  height: 26px;
  color: #413a55;
  background: rgba(99, 201, 168, 0.16);
  border: 1px solid rgba(65, 58, 85, 0.12);
  border-radius: 7px;
  cursor: pointer;
  line-height: 1;
  padding: 0 9px;
  transition: background 0.15s ease, color 0.15s ease;
}
.gen-world button:hover { background: rgba(99, 201, 168, 0.36); }
.gen-wstep { width: 24px; padding: 0 !important; font-size: 0.85rem !important; }
.gen-wtoday.on { background: #63c9a8; color: #17301f; font-weight: 700; }
/* The nameplate doubles as the disclosure for the seed browser: the valley
   always says who it is, and the tools for swapping it stay one click away. */
.gen-world button.gen-wid {
  display: flex;
  align-items: baseline;
  gap: 4px;
  height: auto;
  margin: 0;
  padding: 4px 9px;
  border-radius: 8px;
  font-size: 0.68rem;
  line-height: 1.3;
  font-weight: 700;
  color: #413a55;
  background: rgba(253, 248, 239, 0.92);
  border: 1px solid rgba(65, 58, 85, 0.14);
  box-shadow: 0 3px 10px rgba(31, 28, 45, 0.2);
}
.gen-world button.gen-wid:hover { background: #fff; }
.gen-wid span {
  font-weight: 400;
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}
.gen-wid i {
  font-style: normal;
  font-size: 0.6rem;
  opacity: 0.55;
  margin-left: 1px;
}

.gen-hint {
  margin: 0;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(253, 248, 239, 0.72);
  border: 1px solid rgba(65, 58, 85, 0.12);
  color: #6b6684;
  font-size: 0.68rem;
  line-height: 1.4;
  pointer-events: none;
}

.gen-ticker {
  position: absolute;
  left: 16px;
  bottom: 18px;
  max-width: min(360px, 42vw);
  display: flex;
  flex-direction: column;
  gap: 4px;
  pointer-events: none;
}
.gen-ticker p {
  margin: 0;
  padding: 5px 10px;
  border-radius: 8px;
  font-size: 0.76rem;
  line-height: 1.35;
  background: rgba(253, 248, 239, 0.9);
  border: 1px solid rgba(65, 58, 85, 0.1);
  animation: gen-in 0.45s ease both;
}
.gen-ticker p[data-age='1'] { opacity: 0.72; }
.gen-ticker p[data-age='2'] { opacity: 0.48; }
/* The last hour of a world, and the first minutes of the next one. */
.gen-ticker p { transition: opacity 0.9s ease; }
.gen-ticker.gen-hush p { opacity: 0.34; }
.gen-stamp {
  font-variant-numeric: tabular-nums;
  color: #2f9e7d;
  font-weight: 700;
  margin-right: 7px;
}
@keyframes gen-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .gen-ticker p { animation: none; }
}

.gen-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* Roughly where pointers become fingers: there is no wheel and no ctrl key. */
@media (max-width: 820px) {
  .gen-hint { display: none; }
}

/* A phone is nearly all world, so the chrome earns its space or goes.
 *
 * The ledger goes: three toasts across the bottom-left were most of the valley
 * on a 390pt screen. Nothing is lost — every line still reaches the aria-live
 * mirror below, which is where a screen reader was reading them from anyway.
 *
 * The transport folds: what is left at rest is one chip with the hour on it,
 * and a tap brings back the whole bar. The bar itself cannot hold the transport
 * in one pill at this width without clipping the end off, so when it is open it
 * stops being a pill: the controls keep the top row, the day gets the full
 * width underneath to scrub along, and the buttons grow to something a thumb
 * can actually hit.
 *
 * The zoom column and the nameplate stay put through all of it — they are two
 * small things against the top-right corner, they never cover the settlement
 * (which fits and centres itself), and folding them away too would leave a
 * phone with no way to look closer at the one thing it came for. */
@media (max-width: 620px) {
  .gen-ticker { display: none; }

  .gen-chip {
    position: absolute;
    left: 50%;
    bottom: 12px;
    transform: translateX(-50%);
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 9px;
    height: 40px;
    padding: 0 8px 0 15px;
    border-radius: 999px;
    font: inherit;
    color: #413a55;
    background: rgba(253, 248, 239, 0.94);
    border: 1px solid rgba(65, 58, 85, 0.14);
    box-shadow: 0 8px 26px rgba(31, 28, 45, 0.28);
    backdrop-filter: blur(6px);
    cursor: pointer;
  }
  .gen-chip b { font-size: 0.98rem; font-variant-numeric: tabular-nums; }
  .gen-chiplive {
    padding: 3px 7px;
    border-radius: 999px;
    font-size: 0.58rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    background: rgba(65, 58, 85, 0.1);
    color: #6b6684;
  }
  .gen-chip.on .gen-chiplive { background: #63c9a8; color: #17301f; }
  .gen-chip i { font-style: normal; font-size: 0.7rem; opacity: 0.5; }

  /* The disclosure itself. Everything else in this block describes the bar as
     it looks *once it is open*. */
  .gen-bar { display: none; }
  .genesis.gen-open .gen-bar { display: flex; }
  .genesis.gen-open .gen-chip { display: none; }
  .gen-fold { display: block; }

  .gen-bar {
    left: 10px;
    right: 10px;
    bottom: 12px;
    transform: none;
    max-width: none;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 20px;
  }
  .gen-clock { display: none; }
  .gen-ico { width: 40px; height: 40px; }
  .gen-speed, .gen-pace, .gen-live { height: 40px; }
  /* The one control that has to sit at the far end of the row. */
  .gen-live { margin-left: auto; }
  .gen-scrub { order: 2; flex: 1 0 100%; min-width: 0; height: 26px; }
  .gen-wid span { display: none; }
  .gen-world button { font-size: 0.68rem; padding: 0 7px; }
  .gen-corner { right: 10px; top: 10px; gap: 6px; }
}
`;
