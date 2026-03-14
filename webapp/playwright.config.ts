import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Use a unique DB path per test run so concurrent or repeated runs never conflict.
const E2E_DB_PATH = `/tmp/jot-e2e-${Date.now()}.db`;

export default defineConfig({
  testDir: './e2e/tests',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
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
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `go run main.go`,
    cwd: path.resolve(__dirname, '../server'),
    url: 'http://localhost:8080/livez',
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
