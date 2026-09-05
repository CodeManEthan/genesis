# Genesis

A pixel valley that builds itself from a date. Hash the date into a seed and the
seed is the whole world: the river, the towns, the founders' names, the weather,
the cart on the bridge. Give the same date back and you get the same valley,
down to the pixel.

This repo holds the engine, three React islands, and the harness that keeps the
generator honest. It started as the homepage of
[codemanethan.github.io](https://github.com/CodeManEthan/CodeManEthan.github.io)
and was extracted with its history intact; the portfolio now consumes it as a
package.

## Install

```sh
npm install github:CodeManEthan/genesis
```

`react` and `react-dom` are peer dependencies **only**. Do not move them into
`dependencies`: under `npm link` that gives you two copies of React and the
islands break in ways that look like anything but a duplicate React.

## Import map

The package has one export per source file, so an Astro frontmatter can pull in
`types` without dragging canvas code into the server build.

```js
import { generateMap, buildTimeline } from '@codemanethan/genesis';        // DOM-free barrel
import { poly, buildStructure } from '@codemanethan/genesis/art';          // sprites
import { buildGenesisScene } from '@codemanethan/genesis/scene';           // renderer
import TheGenesis from '@codemanethan/genesis/TheGenesis';                 // islands
```

The root export is deliberately DOM-free: `types`, `daytype`, `gen`, `timeline`,
`names`, `living`, `ghost`. The renderer and the components are not re-exported;
reach for their subpaths. Other subpaths: `/scene`, `/art`, `/fixture`,
`/PastDays`, `/Catalog`, and each engine module by name.

## The rules that matter

- **Determinism is the contract.** The seed is a hash of the UTC date; all
  randomness goes through `mulberry32`. `gen.ts`, `timeline.ts`, `daytype.ts`,
  `living.ts` and `ghost.ts` stay pure — no DOM, no `Date.now()`, no
  `Math.random()` — and import under bare Node 22, so the same seed produces
  byte-identical worlds in the browser and in the harnesses.
- **Append-only history.** The day-type frequency table, event type ranks and
  road trees are append-only, so archived days on `/days` can never change
  retroactively.
- **Subset stability.** A smaller `?pace=` builds a strict prefix of a larger
  one.
- **No DOM at module scope.** `astro build` evaluates `TheGenesis → scene → art`
  in Node even for a `client:only` island. Touch the DOM at module scope and
  every consuming site's build breaks.

## URL parameters

The contract `ab.mjs` and `perf.mjs` drive, on any page mounting `TheGenesis`:

| Param | Effect |
| --- | --- |
| `?seed=` | Build this seed instead of today's date |
| `?day=` | Force a day type (`storm`, `mist`, `stars`, `market`, …) |
| `?t=` | Jump to a world hour |
| `?pace=` | Scale how much gets built in a day |
| `?speed=` | Playback rate |
| `?autoplay=1` | Start running rather than paused |
| `?zoom=` | Camera magnification |
| `?perf=` | Show the perf overlay |
| `?log=` | A played day: the founder's walk, replayed from the doorstep on load (only on a page mounting `TheGenesis` with `avatar`) |

`?seed` plus `?t` plus no autoplay is a paused, reproducible frame, which is
what the pixel A/B capture depends on.

`?log=` is the save file for a played day: `world = f(seed, log)`. It holds
entries joined by `*`, each a one-letter code and a payload. The walk is the
entry `w`, and its payload is every change of held keys against the tick it
landed on (`1I2kA`: from tick 1 hold right, 92 ticks later hold nothing),
plus an optional `.gap` tail marking where the walk ended. A verb is one entry
per act: the code, the world hour to two places, a dash and the target's id
(`f9.50-tr412` fells that tree at half past nine). Verbs are folded into the
day by `buildTimeline(map, pace, inputs)` as a post-pass over the finished
event list, so a day with no verbs is the same array down the same code path.
The walk is replayed against the snapshot the page opens on, so with `?t=` it
is exact and on a live page it is honest to within the day's building. A
truncated or hand-edited log decodes to whatever prefix parses; it never
throws. Entries with a code the engine does not know are skipped.

## Host page contract

The class names and CSS variables are a public API. Consuming pages style them
from outside, so don't rename them.

- `.genesis` is `height: 100%`. **The host must give it a sized box** — a
  wrapper with real dimensions, not `height: auto`. Without one the island
  renders at zero pixels and the page looks blank.
- `PastDays` reads `--card`, `--border`, `--ink-soft` and `--mint` from the
  host. Define them on `:root`; see `site/src/pages/days.astro`.
- `TheGenesis` reads no variables. `Catalog` is self-contained and defines its
  own on `.cat`.
- `.gen-embed .gen-corner` is meant to be overridden from outside, and is, on
  four portfolio pages.
- `PastDays` links to `/`, which assumes the site's homepage is `TheGenesis`.

## Harness

There is no separate test runner. The harnesses are the test suite.

```sh
npm run check    # map, timeline and play harness: reports, invariants, fixtures, the walk
npm run sweep    # invariants only, across 200 seeds
npm run typecheck
npm run build    # tsup: ESM + declarations into dist/
```

In `site/`, against a running dev server:

```sh
npm run perf                       # render-perf matrix in real Chrome
node scripts/ab.mjs capture --out /tmp/ab/before
node scripts/ab.mjs diff /tmp/ab/before /tmp/ab/after
```

`ab.mjs` diffs raw canvas RGBA for seeded paused worlds, which makes it the
parity oracle for any refactor that claims to change nothing. `ab-png.mjs`
writes the same captures out as images. All three drive Chrome through
puppeteer-core and expect it at `/usr/bin/google-chrome`; pass `--url` to point
them at a different dev server.

## Development

```sh
npm install
npm run dev            # tsup --watch
cd site && npm install && npm run dev
```

The site consumes the package through `file:..`, and the exports point at
`dist/`, so keep `tsup --watch` running while you work on the engine.

To develop against the portfolio instead:

```sh
cd ~/projects/genesis
npm link
cd ~/projects/portfolio
npm link @codemanethan/genesis
```

The portfolio's `astro.config.mjs` needs `vite.server.fs.allow` to include the
genesis path, because symlinked dependencies are not allowed automatically. Any
later `npm install` in the portfolio silently drops the link, so re-link after
one.

## Layout

- `src/gen.ts` — the map: river, lakes, roads, town sites, buildings, trees
- `src/timeline.ts` — the day's arc, the pacing solver and the ledger
- `src/daytype.ts` — weather and rare days, and the storm time warp
- `src/living.ts`, `src/ghost.ts` — the people, and yesterday's ruin
- `src/names.ts` — towns and founders
- `src/scene.ts` — the renderer, and the only module that touches the DOM
- `src/art.ts` — the pixel rasteriser and sprite factories everything draws with
- `src/types.ts` — shared types, `mulberry32`, `hashSeed`, tile geometry
- `src/fixture.ts` — hand-built worlds the harness asserts against
- `src/TheGenesis.tsx`, `src/PastDays.tsx`, `src/Catalog.tsx` — the islands
- `scripts/` — the check and sweep harness (pure Node, type stripping)
- `site/` — a standalone Astro site: `/`, `/days`, and a dev-only `/catalog`
