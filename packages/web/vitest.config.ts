import { defineConfig } from 'vitest/config';

// Scoring is pure logic — no DOM, no Next runtime — so a plain Node environment
// is all the tests need. Tests live next to the code they cover in lib/scoring.
export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts'],
    environment: 'node',
  },
});
