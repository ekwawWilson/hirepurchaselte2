import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    setupFiles: ['./tests/setup.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    fileParallelism: false, // tests share the dev SQLite DB; avoid concurrent writers
  },
});
