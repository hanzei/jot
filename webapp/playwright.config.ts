import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  MOCK_IDP_CLIENT_ID,
  MOCK_IDP_CLIENT_SECRET,
  MOCK_IDP_ISSUER,
  MOCK_IDP_READY_PATH,
  MOCK_IDP_REDIRECT_URI,
} from './e2e/fixtures/mock-idp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Use a unique DB DSN per test run so concurrent or repeated runs never conflict.
const E2E_RUN_ID = Date.now();
const E2E_DB_DSN = `/tmp/jot-e2e-${E2E_RUN_ID}.db`;
const SSO_DB_DSN = `/tmp/jot-e2e-sso-${E2E_RUN_ID}.db`;
const SSO_UPLOAD_DIR = `/tmp/jot-e2e-sso-uploads-${E2E_RUN_ID}`;

/** The SSO-enabled instance, and the only spec that runs against it. */
const SSO_BASE_URL = 'http://localhost:8090';
const SSO_SPEC = '**/sso-enabled.spec.ts';

// Both Jot instances share these; each adds its own port, DB and extras.
const JOT_TEST_ENV = {
  JOT_STATIC_DIR: path.resolve(__dirname, 'build'),
  JOT_COOKIE_SECURE: 'false',
  // E2E tests register a fresh user per test across parallel workers,
  // which blows past the per-IP auth rate limit almost immediately.
  JOT_RATE_LIMIT_ENABLED: 'false',
  // With rate limiting off and insecure cookies, keep the servers off every
  // other interface. The base URLs say `localhost`; Node and Chromium fall
  // back to 127.0.0.1 when it resolves to ::1 first.
  JOT_HOST: '127.0.0.1',
};

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
        SSO_SPEC,
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
        SSO_SPEC,
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
    // The only project on the SSO-enabled instance. It needs a live identity
    // provider (the mock IdP below), so it runs on its own server rather than
    // flipping SSO on for the whole suite, whose login and settings specs pin
    // the SSO-off default.
    {
      name: 'sso',
      testMatch: SSO_SPEC,
      use: { ...devices['Desktop Chrome'], baseURL: SSO_BASE_URL },
    },
  ],
  // Started in order, each waiting for the previous one to be ready: the
  // :8080 server builds `build/` that the SSO instance reuses, and the SSO
  // instance runs OIDC discovery against the mock IdP at boot and refuses to
  // start without it.
  webServer: [
    {
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
        ...JOT_TEST_ENV,
        JOT_DB_DSN: E2E_DB_DSN,
        JOT_PORT: '8080',
      },
    },
    {
      // Node runs the TypeScript directly (type stripping, Node >= 22.18).
      command: 'node e2e/fixtures/mock-idp.ts',
      cwd: path.resolve(__dirname),
      url: `${MOCK_IDP_ISSUER}${MOCK_IDP_READY_PATH}`,
      reuseExistingServer: false,
      timeout: 15_000,
    },
    {
      // No webapp build here: it serves the `build/` the first server made.
      // The Go build cache is warm by now, so compiling again is quick.
      command: 'go run main.go',
      cwd: path.resolve(__dirname, '../server'),
      url: `${SSO_BASE_URL}/readyz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...JOT_TEST_ENV,
        JOT_DB_DSN: SSO_DB_DSN,
        JOT_UPLOAD_DIR: SSO_UPLOAD_DIR,
        JOT_PORT: '8090',
        JOT_OIDC_ISSUER: MOCK_IDP_ISSUER,
        JOT_OIDC_CLIENT_ID: MOCK_IDP_CLIENT_ID,
        JOT_OIDC_CLIENT_SECRET: MOCK_IDP_CLIENT_SECRET,
        JOT_OIDC_REDIRECT_URL: MOCK_IDP_REDIRECT_URI,
        JOT_OIDC_PROVIDER_NAME: 'Mock IdP',
        // Mixed mode (also the default): password login stays on alongside
        // SSO, which is what makes linking and unlinking available.
        JOT_LOCAL_LOGIN_ENABLED: 'true',
      },
    },
  ],
});
