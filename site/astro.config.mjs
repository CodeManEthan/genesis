// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
  integrations: [react()],
  vite: {
    server: {
      // The package lives one level up and is linked in through `file:..`, so
      // its source sits outside this site's root. Vite 8 no longer treats a
      // `.git` directory as a workspace root, which leaves the root at site/
      // and makes every `/@fs` path into ../src a 403. scripts/perf.mjs drives
      // the dev server through exactly those paths.
      fs: { allow: ['..'] },
    },
  },
});
