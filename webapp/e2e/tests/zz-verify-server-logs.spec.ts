import { test, expect } from '@playwright/test';

// TEMPORARY (#1088): fails on purpose to exercise the e2e-server-logs upload
// in CI. Reverted before merge.
test('deliberately fails to verify server log artifacts', async ({ request }) => {
  const res = await request.get('/readyz');
  expect(res.status()).toBe(418);
});
