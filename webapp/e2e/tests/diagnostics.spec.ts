import { test, expect } from '../fixtures';
import { readClipboard } from '../fixtures/clipboard';

// Settings > Diagnostics: live-update state and recent failed requests, plus a
// JSON report (with both builds) to paste into a bug report. The builds
// themselves are shown in About.

const REQUEST_ID = 'e2ediag0123456789';

test.describe('Settings diagnostics', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    void authenticatedUser;
  });

  test('shows a connected live-update stream', async ({ settingsPage }) => {
    await settingsPage.goto();

    await expect(settingsPage.diagnosticsField('sse-status')).toHaveText('Connected');
    await expect(settingsPage.diagnosticsField('sse-attempts')).toHaveText('0');
    await expect(settingsPage.diagnosticsSection().getByText('No failed requests since this page was loaded.')).toBeVisible();
  });

  test('follows the stream as it drops and recovers', async ({ page, settingsPage }) => {
    await page.route('**/api/v1/events', (route) => route.abort());
    await settingsPage.goto();

    await expect(settingsPage.diagnosticsField('sse-status')).toHaveText('Connecting');
    await expect(settingsPage.diagnosticsField('sse-attempts')).not.toHaveText('0');

    await page.unroute('**/api/v1/events');
    await expect(settingsPage.diagnosticsField('sse-status')).toHaveText('Connected', { timeout: 15_000 });
    await expect(settingsPage.diagnosticsField('sse-attempts')).toHaveText('0');
  });

  test('lists a failed request with its request ID while the page is open', async ({ settingsPage }) => {
    await settingsPage.goto();
    await settingsPage.failPATCreates(REQUEST_ID);

    await settingsPage.createPAT('Doomed token');

    const list = settingsPage.diagnosticsFailedRequests();
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list).toContainText('POST /pats');
    await expect(list).toContainText('500 internal');
    await expect(list).toContainText(`Ref: ${REQUEST_ID}`);
  });

  test('copies the report as JSON', async ({ page, context, settingsPage }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await settingsPage.goto();
    await expect(settingsPage.diagnosticsField('sse-status')).toHaveText('Connected');
    await settingsPage.failPATCreates(REQUEST_ID);
    await settingsPage.createPAT('Doomed token');
    await expect(settingsPage.diagnosticsFailedRequests()).toBeVisible();

    await settingsPage.copyDiagnosticsReport();

    const text = await readClipboard(page);
    // Request bodies are never recorded.
    expect(text).not.toContain('Doomed token');
    const report = JSON.parse(text);
    expect(report.route).toBe('/settings');
    expect(report.webapp.version).toEqual(expect.any(String));
    expect(report.server.version).toEqual(expect.any(String));
    expect(report.sse).toMatchObject({ status: 'connected', reconnectAttempts: 0 });
    expect(report.failedRequests).toEqual([expect.objectContaining({
      method: 'POST',
      route: '/pats',
      status: 500,
      code: 'internal',
      requestId: REQUEST_ID,
    })]);
  });

  test('About shows the webapp build next to the server build', async ({ settingsPage }) => {
    await settingsPage.goto();
    const dialog = await settingsPage.openAbout();

    await expect(dialog.getByTestId('about-webapp-version')).not.toBeEmpty();
    await expect(dialog.getByTestId('about-webapp-commit')).not.toBeEmpty();
    await expect(dialog.getByRole('heading', { name: 'Server' })).toBeVisible();
    await expect(dialog.getByText('Go Version')).toBeVisible();
  });
});
