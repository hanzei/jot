import { test, expect } from '../fixtures';
import { expectNoViolations } from '../fixtures/axe';
import { MobileAppHandoffPage } from '../pages/MobileAppHandoffPage';

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

  test('prompts on arrival at a shared note link, without opening the note behind it', async ({ page, mobileAppHandoffPage }) => {
    await page.goto(notePath);

    await mobileAppHandoffPage.expectPromptVisible();
    // The note is withheld until the visitor picks the browser, so the prompt
    // never sits on top of a half-drawn note editor.
    await expect(page.getByText('Shared note for handoff')).toBeHidden();
  });

  test('moves focus to the primary action', async ({ page, mobileAppHandoffPage }) => {
    await page.goto(notePath);

    // This overlay is not a Headless UI dialog, so nothing else would put focus
    // on it — see the comment on the render in MobileAppHandoff.tsx.
    await expect(mobileAppHandoffPage.openInAppButton).toBeFocused();
  });

  test('traps Tab inside the prompt', async ({ page, mobileAppHandoffPage }) => {
    await page.goto(notePath);
    await expect(mobileAppHandoffPage.openInAppButton).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(mobileAppHandoffPage.stayInBrowserButton).toBeFocused();

    // Wraps rather than escaping into the note modal behind the scrim, which is
    // what aria-modal="true" promises.
    await page.keyboard.press('Tab');
    await expect(mobileAppHandoffPage.openInAppButton).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect(mobileAppHandoffPage.stayInBrowserButton).toBeFocused();
  });

  test('does not prompt on the dashboard, which the app has no deep link for', async ({ page, mobileAppHandoffPage }) => {
    await page.goto('/');

    await mobileAppHandoffPage.expectPromptHidden();
  });

  test('stays in the browser across arrivals once dismissed', async ({ page, mobileAppHandoffPage }) => {
    await page.goto(notePath);
    await mobileAppHandoffPage.stayInBrowser();

    // The note itself is usable straight away, not left behind a scrim.
    await expect(page.getByText('Shared note for handoff').first()).toBeVisible();

    await page.goto(notePath);
    await mobileAppHandoffPage.expectPromptHidden();
  });

  test('the settings toggle brings the handoff back after a dismissal', async ({ page, mobileAppHandoffPage }) => {
    await page.goto(notePath);
    await mobileAppHandoffPage.stayInBrowser();

    // Reachable because the handoff is scoped to note URLs — were /settings
    // deep-linkable too, the prompt would be covering its own escape hatch.
    await mobileAppHandoffPage.enableFromSettings();

    await page.goto(notePath);
    await mobileAppHandoffPage.expectPromptVisible();
  });

  test('falls back to the prompt when no app answers the deep link', async ({ page, mobileAppHandoffPage }) => {
    await mobileAppHandoffPage.seedAppInstalled();

    await page.goto(notePath);

    await mobileAppHandoffPage.expectPromptVisible();
    await expect(mobileAppHandoffPage.failureNotice).toBeVisible();

    // The stale flag is cleared, so the next arrival prompts instead of
    // stalling on the overlay again.
    await expect.poll(() => mobileAppHandoffPage.installedFlag()).toBeNull();
  });

  test('records the app as installed when the handoff backgrounds the browser', async ({ page, mobileAppHandoffPage }) => {
    await page.goto(notePath);

    await mobileAppHandoffPage.openInApp();
    await expect(mobileAppHandoffPage.attempting).toBeVisible();

    await mobileAppHandoffPage.simulateAppTookOver();

    await expect(mobileAppHandoffPage.attempting).toBeHidden();
    await expect.poll(() => mobileAppHandoffPage.installedFlag()).toBe('1');

    // The tab stops here rather than loading the note for nobody. It cannot
    // close itself, so this screen is the whole of the cleanup available.
    await expect(mobileAppHandoffPage.handedOffScreen).toBeVisible();
    await expect(page.getByText('Shared note for handoff')).toBeHidden();
  });

  // There is deliberately no e2e for leaving the terminal screen. Once the
  // component has assigned `window.location.href = 'jot://…'`, Chromium keeps
  // that navigation pending — it has no handler for the scheme and, headless,
  // no external-protocol prompt to resolve it — and stops delivering input to
  // the page. A synthetic in-page `.click()` still drives the button fine, so
  // the handler is alive and this is an environment artifact rather than a
  // bug; using one here would just assert that React works while quietly
  // giving up on proving the button is clickable. The unit test covers that
  // path with real user-event instead.
});

/**
 * The repo's axe scans live in `accessibility.spec.ts`, which is desktop-only —
 * it would never see this overlay, since the handoff needs a coarse pointer. So
 * the scan lives here instead.
 */
for (const theme of ['light', 'dark'] as const) {
  test.describe(`mobile app handoff accessibility (${theme} theme)`, () => {
    test.use({ colorScheme: theme });

    test('prompt has no WCAG A/AA violations', async ({ page, authenticatedUser, dashboardPage, mobileAppHandoffPage }) => {
      void authenticatedUser;

      await dashboardPage.createNote('Scanned note');
      await dashboardPage.openNote('Scanned note');
      await expect(page).toHaveURL(/\/notes\/[^/]+$/);

      await page.goto(new URL(page.url()).pathname);
      await mobileAppHandoffPage.expectPromptVisible();

      // Scoped to the overlay: the page behind it is already covered by the
      // desktop scans, and re-checking it here only duplicates their findings.
      await expectNoViolations(page, { include: [MobileAppHandoffPage.PROMPT_SELECTOR] });
    });
  });
}
