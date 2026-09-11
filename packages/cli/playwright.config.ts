import { defineConfig } from '@playwright/test';

// WP6 slice D — the browser acceptance suite. It drives the REAL `crib viz` server
// against a real isolated backend (a temp git repo + a temp memory home), so it is
// deliberately NOT chained into the default `pnpm verify` (the 5-cell CI matrix stays
// network-free and Windows-safe); the ubuntu release-gate leg installs browsers and
// runs `verify:browser` instead.
export default defineConfig({
  testDir: './test/browser',
  // The *.browser.ts suffix keeps these files out of vitest's default include
  // (`**/*.{test,spec}.*`) — they are playwright specs, not unit tests.
  testMatch: '**/*.browser.ts',
  // Each spec boots its own backend and mutates it as the spec progresses (admission
  // moves a row, resume appends checkpoints), so workers stay serial.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  retries: 0,
  reporter: [['list']],
  use: {
    viewport: { width: 1280, height: 900 },
  },
});
