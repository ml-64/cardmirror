import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/desktop/_*.ts'],
    benchmark: {
      include: ['benchmarks/**/*.bench.ts'],
    },
    // CI runners have ~7 GB of RAM. The heavy Loro / transclusion co-editing
    // fuzz suites can each peak a fork at a couple GB (multiple wasm peers +
    // megabyte docs), and vitest's default parallelism (one fork per core) then
    // runs several at once and blows the runner's memory — a V8 heap-limit OOM.
    // On CI, cap concurrency to one fork at a time; with per-file isolation each
    // suite still runs in a fresh process, so peak memory is a single file's
    // rather than the sum of several. Local runs keep full parallelism.
    ...(process.env['CI']
      ? { poolOptions: { forks: { minForks: 1, maxForks: 1 } } }
      : {}),
  },
  resolve: {
    alias: [
      // Stub `electron` for desktop-module tests. Electron is a real
      // dependency of `apps/desktop` but is NOT installed in the
      // project root, so tests can't import { app, BrowserWindow,
      // ipcMain } from 'electron' directly. The stub provides the
      // surface the bridge module uses, plus accessors for tests
      // to drive it.
      {
        find: /^electron$/,
        replacement: resolve(__dirname, 'tests/desktop/_electron-stub.ts'),
      },
    ],
  },
});
