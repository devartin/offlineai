import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/tools/kernel/**', 'src/inference/capabilities.ts', 'src/models/**'],
    },
  },
});
