import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/art.ts', 'src/types.ts', 'src/daytype.ts', 'src/gen.ts',
    'src/scene.ts', 'src/timeline.ts', 'src/living.ts', 'src/ghost.ts',
    'src/names.ts', 'src/fixture.ts',
    'src/TheGenesis.tsx', 'src/PastDays.tsx', 'src/Catalog.tsx',
  ],
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  splitting: true,
  treeshake: true,
  sourcemap: true,
  dts: true,
  clean: true,
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});
