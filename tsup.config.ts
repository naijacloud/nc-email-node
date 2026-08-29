import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  // Node 18 is the floor: global fetch, AbortSignal.timeout and
  // crypto.randomUUID are all available there without a polyfill.
  target: 'node18',
  platform: 'node',
  splitting: false,
  treeshake: true,
  // No source maps on purpose. esbuild embeds the original sources in the map,
  // which would publish `src/` to npm through the back door — and the package
  // ships nothing the consumer needs to step through.
  sourcemap: false,
});
