import { test, expect } from '../fixtures';

test.describe('SSE connection status indicator', () => {
  test('surfaces a connection problem when the event stream is unreachable, then clears on recovery', async ({
    page,
    authenticatedUser,
    dashboardPage,
  }) => {
    void authenticatedUser;

    // Block the live-update stream so the EventSource can never open. Other API
    // calls (notes, labels, config) are left untouched so the dashboard loads.
    await page.route('**/api/v1/events', (route) => route.abort());

    // Reload the dashboard so it re-establishes the SSE connection through the
    // blocked route.
    await dashboardPage.goto();

    // The indicator is intentionally delayed (~2s) to avoid flickering on brief
    // blips, so it must not be present the moment the page loads. (The precise
    // delay timing is covered by the component unit tests.)
    await expect(dashboardPage.sseStatusIndicator()).toBeHidden();

    // After the delay it surfaces the problem. The stream never opened, so this
    // is the first-connect state ("Connecting…"), not a reconnect.
    await expect(dashboardPage.sseStatusIndicator()).toBeVisible({ timeout: 10_000 });
    await expect(dashboardPage.sseStatusIndicator()).toContainText('Connecting…');

    // Once the stream is reachable again, the browser's EventSource auto-reconnect
    // re-opens it and the indicator clears.
    await page.unroute('**/api/v1/events');
    await expect(dashboardPage.sseStatusIndicator()).toBeHidden({ timeout: 15_000 });
  });
});
