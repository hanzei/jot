import { test, expect } from '../fixtures';
import { expectNoViolations } from '../fixtures/axe';

// Keys owned by webapp/src/utils/mobileAppHandoff.ts.
const INSTALLED_KEY = 'jot_mobile_app_installed';

/**
 * The handoff only exists on touch devices, so this spec runs in the
 * `mobile-chrome` project alone — see the `testIgnore` in playwright.config.ts.
 *
 * Nothing here can verify that the Jot app actually opens: Chromium has no
 * handler for `jot://`, so every attempt lands on the timeout branch. That is
 * the branch worth guarding anyway — it is what everyone without the app sees.
 */
test.describe('mobile app handoff', () => {
  let notePath: string;

  test.beforeEach(async ({ page, authenticatedUser, dashboardPage }) => {
    void authenticatedUser;

    await dashboardPage.createNote('Shared note for handoff');
    await dashboardPage.openNote('Shared note for handoff');
    await expect(page).toHaveURL(/\/notes\/[^/]+$/);
    notePath = new URL(page.url()).pathname;
    await dashboardPage.closeNoteModal();
  });

  test('prompts on arrival at a shared note link', async ({ page }) => {
    await page.goto(notePath);

    const prompt = page.getByTestId('mobile-app-handoff-prompt');
    await expect(prompt).toBeVisible();
    // The prompt names the instance, which is what tells a multi-server user
    // which server the link belongs to.
    await expect(prompt).toContainText('localhost:8080');
  });

  test('moves focus to the primary action', async ({ page }) => {
    await page.goto(notePath);

    // This overlay is not a Headless UI dialog, so nothing else would put focus
    // on it — see the comment on the render in MobileAppHandoff.tsx.
    await expect(page.getByTestId('mobile-app-handoff-open')).toBeFocused();
  });

  test('does not prompt on the dashboard, which the app has no deep link for', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('mobile-app-handoff-prompt')).toBeHidden();
  });

  test('stays in the browser for good once dismissed', async ({ page }) => {
    await page.goto(notePath);
    await page.getByTestId('mobile-app-handoff-stay').click();

    await expect(page.getByTestId('mobile-app-handoff-prompt')).toBeHidden();
    // The note itself is usable straight away, not left behind a scrim.
    await expect(page.getByText('Shared note for handoff').first()).toBeVisible();

    await page.goto(notePath);
    await expect(page.getByTestId('mobile-app-handoff-prompt')).toBeHidden();
  });

  test('the settings toggle brings the handoff back after a dismissal', async ({ page }) => {
    await page.goto(notePath);
    await page.getByTestId('mobile-app-handoff-stay').click();
    await expect(page.getByTestId('mobile-app-handoff-prompt')).toBeHidden();

    // Reachable because the handoff is scoped to note URLs — were /settings
    // deep-linkable too, the prompt would be covering its own escape hatch.
    await page.goto('/settings');
    const toggle = page.getByTestId('mobile-app-handoff-preference').getByRole('checkbox');
    await expect(toggle).not.toBeChecked();
    await toggle.check();

    await page.goto(notePath);
    await expect(page.getByTestId('mobile-app-handoff-prompt')).toBeVisible();
  });

  test('falls back to the prompt when no app answers the deep link', async ({ page }) => {
    // Pretend a previous handoff from this browser succeeded, which is what
    // turns the prompt into an automatic attempt.
    await page.addInitScript((key) => {
      window.localStorage.setItem(key, '1');
    }, INSTALLED_KEY);

    await page.goto(notePath);

    await expect(page.getByTestId('mobile-app-handoff-prompt')).toBeVisible();
    await expect(page.getByTestId('mobile-app-handoff-failed')).toBeVisible();

    // The stale flag is cleared, so the next arrival prompts instead of
    // stalling on the overlay again.
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), INSTALLED_KEY))
      .toBeNull();
  });

  test('records the app as installed when the handoff backgrounds the browser', async ({ page }) => {
    await page.goto(notePath);

    // Chromium never leaves the page for `jot://`, so drive the same signal the
    // component listens for: the browser losing visibility to another app.
    await page.getByTestId('mobile-app-handoff-open').click();
    await expect(page.getByTestId('mobile-app-handoff-attempting')).toBeVisible();

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect(page.getByTestId('mobile-app-handoff-attempting')).toBeHidden();
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), INSTALLED_KEY))
      .toBe('1');
  });
});

/**
 * The repo's axe scans live in `accessibility.spec.ts`, which is desktop-only —
 * it would never see this overlay, since the handoff needs a coarse pointer. So
 * the scan lives here instead.
 */
for (const theme of ['light', 'dark'] as const) {
  test.describe(`mobile app handoff accessibility (${theme} theme)`, () => {
    test.use({ colorScheme: theme });

    test('prompt has no WCAG A/AA violations', async ({ page, authenticatedUser, dashboardPage }) => {
      void authenticatedUser;

      await dashboardPage.createNote('Scanned note');
      await dashboardPage.openNote('Scanned note');
      await expect(page).toHaveURL(/\/notes\/[^/]+$/);

      await page.goto(new URL(page.url()).pathname);
      await expect(page.getByTestId('mobile-app-handoff-prompt')).toBeVisible();

      // Scoped to the overlay: the page behind it is already covered by the
      // desktop scans, and re-checking it here only duplicates their findings.
      await expectNoViolations(page, { include: ['[data-testid="mobile-app-handoff-prompt"]'] });
    });
  });
}
