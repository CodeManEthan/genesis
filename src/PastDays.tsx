/**
 * Genesis — the days before.
 *
 * An archive of a fortnight of valleys that is not an archive of anything: a
 * day is nothing but (date -> seed), so the whole page is derived in the
 * visitor's own browser from fourteen date strings and the same generator the
 * homepage runs. Nothing was stored when those days happened, and nothing is
 * stored now.
 *
 * Why this has to be a client island: the dates are relative to the visitor's
 * clock. A static build has no idea what "yesterday" is for the person reading
 * it, and the homepage's day boundary is deliberately *local* (see `dayKey` in
 * TheGenesis.tsx), so the archive has to agree with it or a link would open a
 * different valley than the card promised.
 *
 * The thumbnails are real renders, not pictures: each one builds that day's
 * world, holds it at evening and paints one deterministic frame. That is about
 * 200ms of work per day, which is why none of it happens until a card is
 * actually scrolled to, all of it is broken into steps that fit inside a frame,
 * and every scene is torn down the moment its picture has been taken.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { generateMap } from './gen';
import { ghostFor } from './ghost';
import { buildTimeline, festivalAt, snapshotAt } from './timeline';
import { dayInfo, goldStrike, type DayInfo, type DayType } from './daytype';
import {
  buildGenesisSceneSteps,
  makeAmbient,
  renderGenesis,
  settleAmbient,
  type GenesisScene,
} from './scene';
import { TW, TH, hashSeed, type GenesisMap, type RuinSpec } from './types';

/* --------------------------------- shape --------------------------------- */

/** How far back the archive reaches. One card per day, today included. */
const DAYS = 14;

/**
 * The hour every day is remembered at.
 *
 * Late enough that the valley is a valley — the last roof lands between about
 * half eight and ten — and early enough that there is still light on it. The
 * links carry the same number, so the card and the world it opens are the same
 * moment.
 */
const T_EVENING = 20.5;

/** Fixed animation phase: a thumbnail must not depend on when it was drawn. */
const THUMB_CLOCK = 8;

/** Matches the homepage's cap; the blit wants device pixels, not CSS ones. */
const MAX_DPR = 3;

/** Milliseconds of generation work per frame. Below one step is not an option
 * — a generator step is indivisible — so this is a stop line, not a quota. */
const FRAME_BUDGET = 7;

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/** The homepage's day key, verbatim: local, because the clock is local. */
const dayKey = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const daySeed = (d: Date) => hashSeed(dayKey(d));

/** Noon, so a daylight-saving jump can never land the date on its neighbour. */
const noonOffset = (k: number): Date => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() - k, 12);
};

/**
 * A day's month and a day's predecessor, from the calendar rather than from the
 * seed — the archive is the one place that still has the date in its hand.
 *
 * The homepage works both out by searching the calendar for a seed (see
 * `monthOfSeed` / `prevDaySeed` in TheGenesis.tsx), and its search reaches back
 * `RECALL_DAYS` — a fortnight, which is exactly this page's reach. Within that
 * window the two agree by construction, which is the point: a card and the world
 * its link opens have to be the same day, season, ghost and all.
 */
const monthOf = (back: number): number => noonOffset(back).getMonth() + 1;
const prevSeedOf = (back: number): number => daySeed(noonOffset(back + 1));

const dayFor = (back: number, seed: number): DayInfo => dayInfo(seed, monthOf(back));

/* --------------------------------- copy ---------------------------------- */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const DAY_LABEL: Record<DayType, string> = {
  normal: '',
  mist: 'Mist morning',
  storm: 'Storm afternoon',
  aurora: 'Aurora night',
  eclipse: 'Eclipse',
  market: 'Market day',
};

const SEASON_LABEL: Record<string, string> = {
  winter: 'Winter',
  spring: 'Spring',
  summer: 'Summer',
  autumn: 'Autumn',
};

function relative(k: number): string {
  if (k === 0) return 'Today';
  if (k === 1) return 'Yesterday';
  return `${k} days ago`;
}

/* --------------------------------- model --------------------------------- */

interface DayFacts {
  valley: string;
  towns: number;
  founder: string;
  home: string;
  names: string[];
  day: DayInfo;
  festival: boolean;
  gold: boolean;
  /** The last thing the ledger had to say by the hour the picture is taken. */
  line: string;
}

interface DayRow {
  /** 0 = today. */
  back: number;
  key: string;
  seed: number;
  when: string;
  date: string;
  href: string;
  facts: DayFacts | null;
  /** 'idle' until the card has been scrolled to; 'gone' means it will not come. */
  thumb: 'idle' | 'working' | 'done' | 'gone';
}

function rowsFor(): DayRow[] {
  const out: DayRow[] = [];
  for (let k = 0; k < DAYS; k++) {
    const d = noonOffset(k);
    const seed = daySeed(d);
    out.push({
      back: k,
      key: dayKey(d),
      seed,
      when: relative(k),
      date: `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`,
      // Today is simply today: no pinned hour, so it opens live on the
      // visitor's own clock like the front door is supposed to.
      href: k === 0 ? '/' : `/?seed=${seed}&t=${T_EVENING}`,
      facts: null,
      thumb: 'idle',
    });
  }
  return out;
}

/**
 * The one line of ledger a card gets.
 *
 * The very last entry of the evening is usually the day's *shrug* — a late cart,
 * the tools stacked, supper outdoors — and being written for any valley at all
 * it is word for word the same on half the cards, which makes fourteen distinct
 * days look like fourteen copies. So the card takes the last line that names a
 * town instead: those are the ones about this valley and nowhere else.
 */
function ledgerLine(log: { text: string }[], names: string[]): string {
  for (let i = log.length - 1; i >= 0; i--) {
    const text = log[i].text;
    for (const n of names) {
      if (n && text.includes(n)) return text;
    }
  }
  return log.length ? log[log.length - 1].text : '';
}

function factsFor(back: number, seed: number): DayFacts {
  const map = generateMap(seed, 1);
  const tl = buildTimeline(map);
  const snap = snapshotAt(map, tl, T_EVENING);
  const s0 = map.sites[0];
  const names = map.sites.map((s) => s.name);
  return {
    valley: map.valleyName,
    towns: map.sites.length,
    founder: s0?.founder ?? '',
    home: s0?.name ?? '',
    names,
    day: dayFor(back, seed),
    festival: festivalAt(map, tl) > 0,
    gold: !!goldStrike(map),
    line: ledgerLine(snap.log, names),
  };
}

/* ------------------------------- thumbnails ------------------------------- */

/**
 * Give the browser its memory back.
 *
 * A baked scene is the better part of thirty megabytes of canvas — terrain,
 * vegetation and roads are each a full-map layer — and fourteen of them would
 * be a third of a gigabyte held for the sake of fourteen postage stamps. Zeroing
 * a canvas's dimensions is the one portable way to drop its backing store
 * without waiting to see whether the collector agrees.
 */
function release(scene: GenesisScene): void {
  const drop = (c: HTMLCanvasElement | null | undefined) => {
    if (!c) return;
    c.width = 0;
    c.height = 0;
  };
  drop(scene.layer);
  drop(scene.veg?.c);
  drop(scene.roads?.c);
  drop(scene.surround);
  drop(scene.frame);
  drop(scene.glow);
}

/**
 * Shrink `src` onto `dst`, halving as far as it can first.
 *
 * The renderer's own blit is nearest-neighbour on purpose — that is what keeps
 * the art hard-edged at whole magnifications — but a thumbnail is the one place
 * the world is going the other way, and dropping four pixels in five leaves a
 * mess of speckle where the forests are. So the frame is drawn at one device
 * pixel per world pixel and *filtered* down here, halving while a halving is
 * still a shrink, which is the cheap approximation of a proper box filter.
 */
function shrink(
  src: HTMLCanvasElement,
  spare: HTMLCanvasElement,
  dst: HTMLCanvasElement
): void {
  let cur = src;
  let cw = src.width;
  let ch = src.height;
  const dw = dst.width;
  const dh = dst.height;

  // Halve while a halving is still a shrink. What is left over is at worst a
  // 2:1 reduction, which the browser's own filter handles cleanly.
  while (cw >= dw * 2 && ch >= dh * 2 && cw > 2 && ch > 2) {
    const nw = Math.max(1, cw >> 1);
    const nh = Math.max(1, ch >> 1);
    const to = cur === src ? spare : src;
    to.width = nw;
    to.height = nh;
    const c = to.getContext('2d');
    if (!c) break;
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
    cur = to;
    cw = nw;
    ch = nh;
  }

  const d = dst.getContext('2d');
  if (!d) return;
  d.imageSmoothingEnabled = true;
  d.imageSmoothingQuality = 'high';
  d.clearRect(0, 0, dw, dh);
  const s = Math.max(dw / cw, dh / ch);
  const w = cw * s;
  const h = ch * s;
  d.drawImage(cur, 0, 0, cw, ch, (dw - w) / 2, (dh - h) / 2, w, h);
}

/** Scratch canvases, shared by every thumbnail: only one is ever in flight. */
interface Scratch {
  full: HTMLCanvasElement;
  spare: HTMLCanvasElement;
}

/**
 * One day's picture, as a generator so the work can be paid for a frame at a
 * time. The yields sit exactly where the homepage's own pre-midnight build puts
 * them, and for the same reason: no step here is longer than a frame.
 */
function* thumbJob(back: number, seed: number, canvas: HTMLCanvasElement, scratch: Scratch) {
  const map: GenesisMap = generateMap(seed, 1);
  yield;
  const tl = buildTimeline(map);
  yield;
  const snap = snapshotAt(map, tl, T_EVENING);
  // Yesterday's landmark, standing in this valley as a ruin. Costs a map of
  // its own, so it gets a step of its own.
  const ghost: RuinSpec | null = ghostFor(map, prevSeedOf(back));
  yield;

  const steps = buildGenesisSceneSteps(map, dayFor(back, seed), ghost);
  let scene: GenesisScene;
  for (;;) {
    const r = steps.next();
    if (r.done) {
      scene = r.value;
      break;
    }
    yield;
  }

  try {
    scene.fest = festivalAt(map, tl);
    const amb = makeAmbient(1);
    settleAmbient(scene, amb, snap);
    yield;

    // The whole valley, at one world pixel per buffer pixel. `content` is the
    // rect the homepage's own fitted overview frames, so a thumbnail shows
    // exactly what landing on that day shows, only smaller.
    const c = map.content;
    const vw = Math.max(1, Math.round((c.u1 - c.u0) * (TW / 2)));
    const vh = Math.max(1, Math.round((c.v1 - c.v0) * (TH / 2)));
    const full = scratch.full;
    full.width = vw;
    full.height = vh;
    const fctx = full.getContext('2d');
    if (!fctx) return;
    renderGenesis(
      fctx,
      scene,
      amb,
      snap,
      { cx: c.u0 * (TW / 2), cy: c.v0 * (TH / 2), zoom: 1, vw, vh, dpr: 1 },
      THUMB_CLOCK
    );
    yield;
    shrink(full, scratch.spare, canvas);
    // The pictures are taken; the scratch has no business holding a megabyte
    // of valley until the next card scrolls into view.
    scratch.full.width = 0;
    scratch.full.height = 0;
    scratch.spare.width = 0;
    scratch.spare.height = 0;
  } finally {
    release(scene);
  }
}

/* ------------------------------- the island ------------------------------- */

export default function PastDays() {
  const [rows, setRows] = useState<DayRow[]>(() => (typeof window === 'undefined' ? [] : rowsFor()));
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const cards = useRef<(HTMLElement | null)[]>([]);

  /** Indices whose picture has been asked for, in the order they were asked. */
  const wanted = useRef<number[]>([]);
  const queued = useRef<Set<number>>(new Set());
  const rowsRef = useRef<DayRow[]>(rows);
  rowsRef.current = rows;

  const setRow = useCallback((i: number, patch: Partial<DayRow>) => {
    setRows((prev) => {
      const next = prev.slice();
      next[i] = { ...next[i], ...patch };
      return next;
    });
  }, []);

  /* ---- the facts, in reading order ------------------------------------- *
   * Cheap next to a bake — a map, a timeline and a snapshot, about 25ms — but
   * fourteen of them in one tick is half a second of frozen page. One day per
   * frame, then: a card is worth more filled in than filled in sooner, and a
   * whole day's facts already overrun a frame on their own, so there is nothing
   * to gain by batching two of them into one. */
  const factsDone = useRef(false);
  useEffect(() => {
    if (!rows.length) return;
    let raf = 0;
    let i = 0;
    let live = true;
    const step = () => {
      if (!live) return;
      const k = i++;
      if (k >= DAYS) {
        factsDone.current = true;
        return;
      }
      try {
        const f = factsFor(rowsRef.current[k].back, rowsRef.current[k].seed);
        setRow(k, { facts: f });
      } catch {
        /* A day that will not generate simply stays a date. */
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      live = false;
      cancelAnimationFrame(raf);
    };
    // Deliberately once: `rows` is built once and only ever patched in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, setRow]);

  /* ---- the pictures, on demand ----------------------------------------- */
  useEffect(() => {
    if (!rows.length) return;
    let live = true;
    let raf = 0;
    const scratch: Scratch = {
      full: document.createElement('canvas'),
      spare: document.createElement('canvas'),
    };
    let job: Generator<void, void, void> | null = null;
    let jobIndex = -1;

    const dpr = Math.min(Math.max(1, window.devicePixelRatio || 1), MAX_DPR);

    /** Size a card's canvas to its box in *device* pixels, the homepage's own
     * convention: layout is CSS pixels, the backing store is real ones. */
    const fit = (canvas: HTMLCanvasElement): boolean => {
      const r = canvas.getBoundingClientRect();
      const w = Math.round((r.width || 320) * dpr);
      const h = Math.round((r.height || 188) * dpr);
      if (w < 8 || h < 8) return false;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      return true;
    };

    const pump = () => {
      if (!live) return;
      // Never share a frame with the facts pass. Both are chunked, but a scene
      // step and a day's facts landing in the same tick add up to a hitch, and
      // the words are the part of the page worth having first anyway.
      if (!factsDone.current) {
        raf = requestAnimationFrame(pump);
        return;
      }
      const start = performance.now();
      do {
        if (!job) {
          const next = wanted.current.shift();
          if (next === undefined) {
            raf = 0;
            return;
          }
          const canvas = canvases.current[next];
          if (!canvas || !fit(canvas)) {
            setRow(next, { thumb: 'gone' });
            continue;
          }
          jobIndex = next;
          job = thumbJob(rowsRef.current[next].back, rowsRef.current[next].seed, canvas, scratch);
          setRow(next, { thumb: 'working' });
        }
        try {
          if (job.next().done) {
            setRow(jobIndex, { thumb: 'done' });
            job = null;
            // The frame a scene is finished in is also the frame it is torn
            // down and handed to the compositor. Starting the next day's map
            // on top of that is the one pile-up worth refusing.
            break;
          }
        } catch {
          setRow(jobIndex, { thumb: 'gone' });
          job = null;
          break;
        }
      } while (performance.now() - start < FRAME_BUDGET);
      raf = requestAnimationFrame(pump);
    };

    const kick = () => {
      if (!raf) raf = requestAnimationFrame(pump);
    };

    /* A picture is only worth 200ms if somebody is looking at the card. */
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const i = cards.current.indexOf(e.target as HTMLElement);
          if (i < 0 || queued.current.has(i)) continue;
          queued.current.add(i);
          wanted.current.push(i);
          io.unobserve(e.target);
        }
        kick();
      },
      { rootMargin: '300px 0px' }
    );
    for (const el of cards.current) if (el) io.observe(el);

    return () => {
      live = false;
      io.disconnect();
      if (raf) cancelAnimationFrame(raf);
      scratch.full.width = 0;
      scratch.spare.width = 0;
    };
  }, [rows.length, setRow]);

  const today = rows[0];

  return (
    <>
      <style>{CSS}</style>
      <ol className="pd-grid">
        {rows.map((r, i) => (
          <li key={r.key}>
            <a
              className={`pd-card${r.back === 0 ? ' pd-today' : ''}`}
              href={r.href}
              ref={(el) => {
                cards.current[i] = el;
              }}
            >
              <span className={`pd-thumb${r.thumb === 'done' ? ' pd-painted' : ''}`}>
                <canvas
                  ref={(el) => {
                    canvases.current[i] = el;
                  }}
                  aria-hidden="true"
                />
                {r.thumb !== 'done' && (
                  <span className="pd-thumb-note" aria-hidden="true">
                    {r.thumb === 'gone' ? r.key : 'building…'}
                  </span>
                )}
              </span>

              <span className="pd-body">
                <span className="pd-when">
                  <b>{r.when}</b>
                  <i>{r.date}</i>
                </span>

                <span className="pd-valley">{r.facts ? r.facts.valley : ' '}</span>

                <span className="pd-facts">
                  {r.facts
                    ? `${r.facts.towns} town${r.facts.towns === 1 ? '' : 's'}${
                        r.facts.founder ? ` · ${r.facts.founder} drove the first stake` : ''
                      }`
                    : 'reading the seed…'}
                </span>

                {r.facts && (
                  <span className="pd-chips">
                    <span className="pd-chip pd-season">{SEASON_LABEL[r.facts.day.season]}</span>
                    {r.facts.day.type !== 'normal' && (
                      <span className="pd-chip pd-rare">{DAY_LABEL[r.facts.day.type]}</span>
                    )}
                    {r.facts.festival && <span className="pd-chip pd-rare">Festival at dusk</span>}
                    {r.facts.gold && <span className="pd-chip pd-rare">Gold strike</span>}
                  </span>
                )}

                {r.facts && r.facts.names.length > 0 && (
                  <span className="pd-names">{r.facts.names.join(' · ')}</span>
                )}

                {r.facts && r.facts.line && <span className="pd-line">{r.facts.line}</span>}

                <span className="pd-go">
                  {r.back === 0 ? 'Open today’s valley →' : 'Open this day at 20:30 →'}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ol>

      {today && (
        <p className="pd-foot">
          Fourteen dates, fourteen seeds, nothing kept. Every card above was
          worked out in this browser in the last few seconds, and the pictures
          are the real world held at half past eight in the evening — the hour a
          link opens it at.
        </p>
      )}
    </>
  );
}

/* ---------------------------------- css ---------------------------------- */

const CSS = `
.pd-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
  gap: 1.3rem;
}

.pd-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--card, #fff);
  border: 2px solid var(--border, #ece3d2);
  border-radius: 16px;
  overflow: hidden;
  color: inherit;
  text-decoration: none;
  transition: transform 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
}

.pd-card:hover,
.pd-card:focus-visible {
  transform: translateY(-3px);
  border-color: var(--mint, #63c9a8);
  box-shadow: 0 10px 26px rgba(65, 58, 85, 0.12);
}

.pd-card.pd-today {
  border-color: color-mix(in srgb, var(--mint, #63c9a8) 55%, var(--border, #ece3d2));
}

.pd-thumb {
  position: relative;
  display: block;
  aspect-ratio: 17 / 10;
  background:
    linear-gradient(180deg, #cfe3d5 0%, #b9d6c4 46%, #a8c9b3 100%);
  border-bottom: 2px solid var(--border, #ece3d2);
}

.pd-thumb canvas {
  display: block;
  width: 100%;
  height: 100%;
  opacity: 0;
  transition: opacity 0.45s ease;
}

.pd-thumb.pd-painted canvas { opacity: 1; }

.pd-thumb-note {
  position: absolute;
  inset: auto 0 0.5rem 0;
  text-align: center;
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: rgba(38, 72, 58, 0.5);
}

.pd-body {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.95rem 1.1rem 1.05rem;
  flex: 1;
}

.pd-when {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  font-size: 0.7rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.pd-when b { font-weight: 800; color: #2f8f74; }
.pd-when i { font-style: normal; font-weight: 700; color: var(--ink-soft, #7a7690); }

.pd-valley {
  font-size: 1.12rem;
  font-weight: 800;
  line-height: 1.25;
  letter-spacing: -0.01em;
  min-height: 1.4em;
}

.pd-facts {
  font-size: 0.85rem;
  color: var(--ink-soft, #7a7690);
}

.pd-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.pd-chip {
  font-size: 0.68rem;
  font-weight: 700;
  padding: 0.05rem 0.55rem;
  border-radius: 999px;
  border: 1px solid var(--border, #ece3d2);
  color: var(--ink-soft, #7a7690);
}

.pd-chip.pd-rare {
  border-color: color-mix(in srgb, var(--mint, #63c9a8) 60%, #fff);
  background: color-mix(in srgb, var(--mint, #63c9a8) 16%, #fff);
  color: #1d6752;
}

.pd-names {
  font-size: 0.74rem;
  line-height: 1.45;
  color: color-mix(in srgb, var(--ink-soft, #7a7690) 80%, #fff);
}

.pd-line {
  font-size: 0.8rem;
  font-style: italic;
  line-height: 1.45;
  color: var(--ink-soft, #7a7690);
  border-left: 2px solid var(--border, #ece3d2);
  padding-left: 0.6rem;
}

.pd-go {
  margin-top: auto;
  padding-top: 0.35rem;
  font-size: 0.82rem;
  font-weight: 700;
  color: #2f8f74;
}

.pd-foot {
  margin: 2.2rem 0 0;
  max-width: 46rem;
  font-size: 0.85rem;
  color: var(--ink-soft, #7a7690);
}

@media (prefers-reduced-motion: reduce) {
  .pd-card { transition: none; }
  .pd-card:hover, .pd-card:focus-visible { transform: none; }
  .pd-thumb canvas { transition: none; }
}
`;
