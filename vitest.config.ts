import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@neomd/shared': resolve(root, 'packages/shared/src/index.ts'),
      '@neomd/core': resolve(root, 'packages/core/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
