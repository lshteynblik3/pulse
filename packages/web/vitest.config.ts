import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Most tests are pure logic in a Node env (lib/scoring, lib/dashboard, pairing
// crypto). A few component tests opt into jsdom per-file via a
// `// @vitest-environment jsdom` docblock — the default below stays node.
export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
  // React 19 automatic JSX runtime for the .tsx component tests.
  esbuild: { jsx: 'automatic' },
  // Mirror the Next `@/* -> src/*` path alias so component imports resolve.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
