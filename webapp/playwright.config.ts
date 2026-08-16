import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Use a unique DB DSN per test run so concurrent or repeated runs never conflict.
const E2E_DB_DSN = `/tmp/jot-e2e-${Date.now()}.db`;

export default defineConfig({
  testDir: './e2e/tests',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  ...(process.env.CI && { workers: 4 }),
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:8080',
    locale: 'en-US',
    trace: 'on-first-retry',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    serviceWorkers: 'block',
  },
  projects: [
    // Admin tests run first in isolation before parallel workers start.
    // They rely on aggregate DB counts that would be skewed by concurrent registrations.
    {
      name: 'admin',
      testMatch: '**/00-admin.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: [
        '**/00-admin.spec.ts',
        // The handoff is gated on a coarse pointer, so it has nothing to assert
        // against a desktop mouse — it correctly never appears.
        '**/mobile-app-handoff.spec.ts',
      ],
      dependencies: ['admin'],
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
      testIgnore: [
        '**/keyboard-shortcuts.spec.ts',
        '**/00-admin.spec.ts',
        '**/notes-grouping.spec.ts',
        // Both a11y specs are desktop-only. The axe scans would re-check the
        // same components against the same rules — the markup does not change
        // with the viewport — and the keyboard/focus specs assume a physical
        // keyboard the mobile emulation does not model.
        '**/accessibility.spec.ts',
        '**/keyboard-focus.spec.ts',
      ],
      dependencies: ['admin'],
    },
  ],
  webServer: {
    command: `npm run --prefix ${path.resolve(__dirname)} build && go run main.go`,
    cwd: path.resolve(__dirname, '../server'),
    url: 'http://localhost:8080/readyz',
    reuseExistingServer: false,
    // Generous because this command does a full webapp build *and* compiles
    // the server. On a cold Go build cache that alone can take minutes, and a
    // startup timeout surfaces as every test failing for no visible reason.
    // `task test-e2e` pre-warms the Go build cache to keep this well under.
    timeout: 180_000,
    env: {
      JOT_DB_DSN: E2E_DB_DSN,
      JOT_STATIC_DIR: path.resolve(__dirname, 'build'),
      JOT_PORT: '8080',
      JOT_COOKIE_SECURE: 'false',
      // E2E tests register a fresh user per test across parallel workers,
      // which blows past the per-IP auth rate limit almost immediately.
      JOT_RATE_LIMIT_ENABLED: 'false',
    },
  },
});
