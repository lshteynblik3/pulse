import { defineConfig } from 'vitest/config';

// Tested code is pure logic — no DOM, no Next runtime — so a plain Node
// environment is all the tests need. Tests live next to the code they cover
// (lib/scoring for scoring, src/lib/devices for pairing crypto).
export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
