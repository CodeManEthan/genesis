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
import {
  TH,
  TW,
  hashSeed,
  type GenesisMap,
  type Timeline,
  type WorldSnapshot,
} from './types';
import {
  buildGenesisScene,
  makeAmbient,
  renderGenesis,
  resetAmbient,
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

function loadWorld(seed: number): World {
  if (USE_GENERATED) {
    const map = generateMap(seed);
    return { map, timeline: buildTimeline(map), emptySnapshot, snapshotAt, advance };
  }
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
const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);
const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

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

function utcDateKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

interface Cam {
  cx: number;
  cy: number;
  zoom: number;
}

/* ------------------------------- component ------------------------------- */

export default function TheGenesis() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<'live' | 'player'>('live');
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(1);
  const [tDisp, setTDisp] = useState(0);
  const [valley, setValley] = useState('');
  const [lines, setLines] = useState<{ t: number; text: string }[]>([]);

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
  const logLenRef = useRef(0);

  const api = useRef<{
    applyT: (t: number) => void;
    paint: () => void;
    fit: () => void;
    stepZoom: (dir: 1 | -1, ax?: number, ay?: number) => void;
    pan: (dx: number, dy: number) => void;
  } | null>(null);

  /* ------------------------------- sizing ------------------------------- */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      setSize((prev) =>
        prev && Math.abs(prev.w - r.width) < 1 && Math.abs(prev.h - r.height) < 1
          ? prev
          : { w: Math.max(1, r.width), h: Math.max(1, r.height) }
      );
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
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
      const seed = q.has('seed') && isFinite(qSeed) ? qSeed >>> 0 : hashSeed(utcDateKey());
      const world = loadWorld(seed);
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
      sceneRef.current = buildGenesisScene(world.map);
      ambRef.current = makeAmbient();
      settleAmbient(sceneRef.current, ambRef.current, snapRef.current);
      logLenRef.current = snapRef.current.log.length;
      setLines(snapRef.current.log.slice(-3));
      setReady(true);
    }

    const world = worldRef.current!;
    const scene = sceneRef.current!;
    const amb = ambRef.current!;

    const vw = Math.max(1, Math.round(size.w));
    const vh = Math.max(1, Math.round(size.h));
    canvas.width = vw;
    canvas.height = vh;
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;
    ctx.imageSmoothingEnabled = false;

    /* ---- zoom ladder: fitted overview, then whole-pixel steps ---------- */
    const c = world.map.content;
    const contentW = Math.max(1, (c.u1 - c.u0) * (TW / 2));
    const contentH = Math.max(1, (c.v1 - c.v0) * (TH / 2));
    const raw = Math.min(vw / contentW, vh / contentH);
    // Above 1× the art wants whole-number magnification or the tile edges go
    // uneven; below it, any scale is fine because we are downsampling.
    const overview = raw >= 1 ? Math.max(1, Math.floor(raw)) : Math.max(0.24, raw);
    const ladder: number[] = [overview];
    for (const z of [0.5, 1, 2, 3, 4]) {
      if (z > ladder[ladder.length - 1] * 1.15) ladder.push(z);
    }
    while (ladder.length < 4) ladder.push(ladder[ladder.length - 1] * 2);
    ladderRef.current = ladder;

    const fitCam = (): Cam => {
      const z = overview;
      return {
        zoom: z,
        cx: c.u0 * (TW / 2) + contentW / 2 - vw / z / 2,
        cy: c.v0 * (TH / 2) + contentH / 2 - vh / z / 2,
      };
    };

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
      camRef.current = fitCam();
      // Dev-only camera params, used by the screenshot harness to inspect a
      // particular corner of the valley at a particular magnification.
      const q = new URLSearchParams(window.location.search);
      const qz = Number(q.get('zoom'));
      const qx = Number(q.get('cx'));
      const qy = Number(q.get('cy'));
      if (q.has('zoom') && qz > 0) camRef.current.zoom = qz;
      if (q.has('cx') && isFinite(qx)) camRef.current.cx = qx - vw / camRef.current.zoom / 2;
      if (q.has('cy') && isFinite(qy)) camRef.current.cy = qy - vh / camRef.current.zoom / 2;
    }
    clampCam(camRef.current);

    /* ---- clock ---------------------------------------------------------- */
    let clock = 8;

    const pushLog = () => {
      const snap = snapRef.current!;
      if (snap.log.length === logLenRef.current) return;
      logLenRef.current = snap.log.length;
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
        logLenRef.current = -1;
      } else {
        world.advance(snap, world.timeline, t);
      }
      tRef.current = t;
      dirtyRef.current = true;
      pushLog();
    };
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
        camRef.current = clampCam({ zoom: next, cx: wx - px / next, cy: wy - py / next });
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
    };

    function paintOnce() {
      const cam = camRef.current!;
      renderGenesis(ctx!, scene, amb, snapRef.current!, { ...cam, vw, vh }, clock);
      dirtyRef.current = false;
    }

    /* ---- the tick ------------------------------------------------------- */
    let uiAccum = 0;
    const tick = (dt: number) => {
      const running = modeRef.current === 'live' || playingRef.current;
      if (modeRef.current === 'live') {
        applyT(wallClockHours());
      } else if (playingRef.current) {
        applyT(tRef.current + (dt * speedRef.current) / 3600);
        if (tRef.current >= 24 - 1e-6) {
          playingRef.current = false;
          setPlaying(false);
        }
      }
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
      e.preventDefault();
      const r = el.getBoundingClientRect();
      api.current?.stepZoom(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ready]);

  /* ------------------------------ transport ------------------------------ */
  const detach = useCallback(() => {
    modeRef.current = 'player';
    setMode('player');
  }, []);

  const seek = useCallback(
    (t: number) => {
      detach();
      api.current?.applyT(t);
      setTDisp(clamp(t, 0, 24));
      api.current?.paint();
    },
    [detach]
  );

  const togglePlay = useCallback(() => {
    detach();
    playingRef.current = !playingRef.current;
    setPlaying(playingRef.current);
    api.current?.paint();
  }, [detach]);

  const cycleSpeed = useCallback(() => {
    setSpeedIdx((i) => {
      const n = (i + 1) % SPEEDS.length;
      speedRef.current = SPEEDS[n];
      return n;
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
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' && e.key === ' ') return;
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
  }, [togglePlay, seek]);

  const latest = lines.length ? lines[lines.length - 1].text : '';
  const pct = (clamp(tDisp, 0, 24) / 24) * 100;

  return (
    <div className="genesis" ref={wrapRef}>
      <style>{CSS}</style>
      <canvas
        ref={canvasRef}
        className="gen-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        aria-label={`A pixel-art valley called ${valley}, ${
          mode === 'live' ? 'live at' : 'held at'
        } ${fmtClock(tDisp)} of its first day.`}
        role="img"
      />

      <div className="gen-ticker" aria-hidden="true">
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

      <div className="gen-bar" role="group" aria-label="World clock">
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
  touch-action: none;
}
.gen-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  image-rendering: pixelated;
}
.gen-canvas:active { cursor: grabbing; }

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

.gen-zoom {
  position: absolute;
  right: 16px;
  top: 16px;
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

@media (max-width: 620px) {
  .gen-clock { display: none; }
  .gen-ticker { max-width: 62vw; bottom: 74px; }
}
`;
