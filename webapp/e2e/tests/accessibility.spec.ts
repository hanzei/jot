import { test, expect, E2E_ADMIN_CREDENTIALS } from '../fixtures';
import { expectNoViolations } from '../fixtures/axe';
import type { Page } from '@playwright/test';

/**
 * Automated WCAG A/AA scans over the app's main surfaces, in both themes.
 *
 * Scope and limits are worth stating up front, because a green axe run reads as
 * a stronger claim than it is: axe catches roughly a third of WCAG issues, and
 * essentially none of the keyboard and focus behaviour that a modal-heavy app
 * actually breaks on. That half lives in `keyboard-focus.spec.ts`; the two
 * specs are complements and neither is sufficient alone.
 *
 * Every surface is scanned twice, once per theme. Contrast is the reason: it is
 * the one rule whose result depends on rendered colour, so a light-only scan
 * says nothing about the `dark:` variants — and Jot styles nearly every surface
 * in both.
 */

const THEMES = ['light', 'dark'] as const;

/** Every swatch in the note colour picker, by its accessible name. */
const NOTE_COLOURS = [
  'Coral', 'Yellow', 'Lime', 'Teal', 'Periwinkle',
  'Lavender', 'Pink', 'Sand', 'Gray', 'White',
] as const;

/**
 * Confirms the emulated colour scheme actually reached the DOM.
 *
 * Without this the dark-theme scans are the failure mode that looks like a
 * pass: if `applyTheme` stopped honouring the system preference, every "dark"
 * scan would quietly run against light markup and still go green.
 */
async function expectTheme(page: Page, theme: (typeof THEMES)[number]) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(theme === 'dark');
}

for (const theme of THEMES) {
  test.describe(`Accessibility (${theme} theme)`, () => {
    test.use({ colorScheme: theme });

    test('login page has no WCAG A/AA violations', async ({ page, loginPage }) => {
      await loginPage.goto();
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
      await expectTheme(page, theme);

      await expectNoViolations(page);
    });

    test('register page has no WCAG A/AA violations', async ({ page, registerPage }) => {
      await registerPage.goto();
      await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
      await expectTheme(page, theme);

      await expectNoViolations(page);
    });

    test('dashboard has no WCAG A/AA violations', async ({ page, authenticatedUser, dashboardPage }) => {
      void authenticatedUser;
      await dashboardPage.goto();
      // Scan a populated dashboard, not the empty state: the note grid, the
      // label chips and the card overflow buttons are the bulk of the markup
      // and none of them render until a note exists.
      await dashboardPage.createNoteWithLabels('A11y Text Note', '', ['a11y-label']);
      await dashboardPage.createListNote('A11y List Note', ['first item', 'second item']);
      await expectTheme(page, theme);

      await expectNoViolations(page);
    });

    test('note modal has no WCAG A/AA violations', async ({ page, authenticatedUser, dashboardPage }) => {
      void authenticatedUser;
      await dashboardPage.goto();
      await dashboardPage.createListNote('A11y Modal Note', ['first item', 'second item']);
      await dashboardPage.openNote('A11y Modal Note');
      await expect(page.locator('[role="dialog"][aria-modal="true"] [data-testid="list-item-input"]').first()).toBeVisible();
      await expectTheme(page, theme);

      // The dashboard behind the open modal is still in the accessibility
      // tree, so its note cards are part of this scan too.
      await expectNoViolations(page);
    });

    test('read-only bin note modal has no WCAG A/AA violations', async ({ page, authenticatedUser, dashboardPage }) => {
      void authenticatedUser;
      await dashboardPage.goto();
      await dashboardPage.createListNote('A11y Bin Note', ['first item', 'second item']);
      await dashboardPage.deleteNote('A11y Bin Note');
      await dashboardPage.switchToBin();
      await dashboardPage.openNote('A11y Bin Note');
      await expect(page.locator('[role="dialog"][aria-modal="true"]').getByPlaceholder('Note title...')).toBeVisible();
      await expectTheme(page, theme);

      await expectNoViolations(page);
    });

    test('note modal has no WCAG A/AA violations in any note colour', async ({ page, authenticatedUser, dashboardPage }) => {
      void authenticatedUser;
      // Ten colours × two save states = twenty scans, plus a two-second settle
      // per colour. Comfortably past the 30s default, and slower again on CI.
      test.setTimeout(150_000);
      await dashboardPage.goto();
      await dashboardPage.createListNote('A11y Colour Note', ['first item']);
      await dashboardPage.openNote('A11y Colour Note');
      await expect(page.locator('[role="dialog"][aria-modal="true"] [data-testid="list-item-input"]').first()).toBeVisible();
      await expectTheme(page, theme);

      // The note's colour is applied to the whole DialogPanel, so every piece
      // of modal chrome — "Last edited", the drag grips, the icon buttons —
      // sits on it. A scan of the default white note says nothing about the
      // other nine backgrounds, and the muted tokens are the ones at risk.
      const saveStatus = page.getByTestId('note-save-status');
      for (const colour of NOTE_COLOURS) {
        await dashboardPage.setNoteColorFromModal(colour);

        // Recolouring saves, so the status region shows a green "Saved" for two
        // seconds and then settles back to a grey "Last edited". Both ride on
        // the note colour and use different tokens, so scanning only whichever
        // happened to be on screen would leave one of them unchecked — and
        // would pass or fail at random. Take them in order instead: the green
        // one scoped to the status region, which finishes well inside its
        // window, then the whole modal once it has settled.
        await expect(saveStatus.getByText('Saved')).toBeVisible();
        await expectNoViolations(page, { include: ['[data-testid="note-save-status"]'] });

        await expect(saveStatus.getByText(/Last edited/)).toBeVisible();
        await expectNoViolations(page);
      }
    });

    test('settings page has no WCAG A/AA violations', async ({ page, authenticatedUser, settingsPage }) => {
      void authenticatedUser;
      await settingsPage.goto();
      await expect(page.getByRole('heading', { name: 'Active Sessions' })).toBeVisible();
      await expectTheme(page, theme);

      await expectNoViolations(page);
    });

    test('my tasks view has no WCAG A/AA violations', async ({ page, authenticatedUser, dashboardPage }) => {
      void authenticatedUser;
      await dashboardPage.goto();
      await dashboardPage.createListNote('A11y Tasks Note', ['first item']);
      await dashboardPage.switchToMyTasks();
      await expect(page).toHaveURL(/view=my-tasks/);
      await expectTheme(page, theme);

      await expectNoViolations(page);
    });

    test('admin page has no WCAG A/AA violations', async ({ page }) => {
      // The admin surface needs the bootstrap admin, which global setup
      // registers as the instance's first (and therefore only) admin user.
      // This scan is read-only, so unlike 00-admin.spec.ts it does not need to
      // run serially — nothing here depends on aggregate counts holding still.
      const login = await page.request.post('/api/v1/login', { data: E2E_ADMIN_CREDENTIALS });
      expect(login.ok(), `admin login failed with ${login.status()}`).toBeTruthy();

      await page.goto('/admin');
      await expect(page.getByRole('heading', { name: 'User Management' })).toBeVisible();
      await expectTheme(page, theme);

      await expectNoViolations(page);
    });
  });
}
