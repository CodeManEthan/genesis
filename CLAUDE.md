# Genesis

The engine, the React islands and the harness for a pixel valley generated from
a date. Read README.md for the determinism rules, the URL-parameter contract and
the host-page contract before changing anything in `src/`.

## Development

```sh
npm install
npm run dev          # tsup --watch — the site imports dist/, so keep this running
npm run typecheck    # tsc --noEmit
npm run build        # tsup: ESM + declarations
npm run check        # map + timeline harness: reports, invariants, fixtures
npm run sweep        # invariants across 200 seeds
```

The site is a separate project with its own lockfile:

```sh
cd site
npm install
npm run dev          # Astro on port 4321
npm run perf         # render-perf matrix, needs the dev server running
```

`npm run check` is the regression gate. Its output is deterministic, so diff it
before and after any change that is supposed to be behavior-preserving; a
changed line means the world changed.

## Rules

Whenever a feature adds or changes art/sprites/roles/props/day-types, update the
dev-only /catalog page (and its coverage notes) in the same change — the catalog
must never fall behind the actual world.
