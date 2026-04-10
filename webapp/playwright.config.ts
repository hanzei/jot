import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Use a unique DB path per test run so concurrent or repeated runs never conflict.
const E2E_DB_PATH = `/tmp/jot-e2e-${Date.now()}.db`;

export default defineConfig({
  testDir: './e2e/tests',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 4 : undefined,
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
      testIgnore: '**/00-admin.spec.ts',
      dependencies: ['admin'],
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
      testIgnore: ['**/keyboard-shortcuts.spec.ts', '**/00-admin.spec.ts'],
      dependencies: ['admin'],
    },
  ],
  webServer: {
    command: `npm run --prefix ${path.resolve(__dirname)} build && go run main.go`,
    cwd: path.resolve(__dirname, '../server'),
    url: 'http://localhost:8080/readyz',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      DB_PATH: E2E_DB_PATH,
      STATIC_DIR: path.resolve(__dirname, 'build'),
      PORT: '8080',
      JWT_SECRET: 'e2e-test-secret',
      COOKIE_SECURE: 'false',
    },
  },
});
