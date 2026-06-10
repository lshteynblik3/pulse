import { defineConfig } from 'vitest/config';

// The agent's pure logic (normalize, heuristics, the lookup chain) is unit-tested
// in a plain Node environment — no Electron, no DOM.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
