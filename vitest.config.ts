import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    // The retry tests wait out real backoff sleeps against a real loopback
    // server. Nothing here talks to the network, but jittered sleeps plus a
    // Retry-After of one second exceed vitest's 5s default on a loaded box.
    testTimeout: 30_000,
  },
});
