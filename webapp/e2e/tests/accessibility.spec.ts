import { test, expect, uniqueUsername, E2E_ADMIN_CREDENTIALS } from '../fixtures';
import { expectNoViolations } from '../fixtures/axe';
import { openNoteInConflict } from '../fixtures/noteConflict';
import { createListNote, createTextNote, setPublicLink, signUp } from '../fixtures/publicLinks';
import type { Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const noteImageBuffer = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/test-icon.png'));

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

/** CODE_SCOPES from @jot/shared, which the e2e project cannot import. */
const CODE_SCOPES = ['keyword', 'type', 'string', 'attribute', 'literal', 'title', 'comment'] as const;

/** One fence per grammar family, between them covering every token scope. */
const HIGHLIGHTED_CODE_NOTE = [
  '```ts',
  '// A11y code sample',
  'export function greet(n: string): number {',
  '  return this.count + 42;',
  '}',
  '```',
  '',
  '```html',
  '<a href="https://example.com">x</a>',
  '```',
].join('\n');

/** One code line far wider than the modal, with and without break points. */
const LONG_CODE_NOTE = [
  'A11y long code',
  '',
  '```',
  `const message = ${'"a long string literal that keeps going", '.repeat(8)};`,
  'x'.repeat(400),
  '```',
].join('\n');

/** Every swatch in the note colour picker, by its accessible name. */
const NOTE_COLOURS = [
  'Coral', 'Yellow', 'Lime', 'Teal', 'Periwinkle',
  'Lavender', 'Pink', 'Sand', 'Gray', 'Default',
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

    test('dashboard with selected notes has no WCAG A/AA violations', async ({ page, authenticatedUser, dashboardPage }) => {
      void authenticatedUser;
      await dashboardPage.goto();
      await dashboardPage.createNoteWithLabels('A11y Selected Note', '', ['a11y-select-label']);
      await dashboardPage.createListNote('A11y Unselected Note', ['first item']);
      await expectTheme(page, theme);

      // The selected state: the checkbox shown on every card, the selected
      // card's ring, and the action bar in the header.
      await dashboardPage.toggleNoteSelection('A11y Selected Note');
      await dashboardPage.expectSelectionCount(1);
      await expectNoViolations(page);

      // The labels menu.
      await dashboardPage.selectionAction('Labels').click();
      await expect(page.getByTestId('note-selection-labels')).toBeVisible();
      await expectNoViolations(page);
    });

    test('error fallbacks have no WCAG A/AA violations', async ({ page, authenticatedUser, errorFallbackPage }) => {
      void authenticatedUser;
      await errorFallbackPage.breakNoteList();
      await page.goto('/');
      await expect(errorFallbackPage.section()).toBeVisible();
      await expectTheme(page, theme);
      await expectNoViolations(page);

      await errorFallbackPage.breakSidebarLabels();
      await page.reload();
      await expect(errorFallbackPage.root()).toBeVisible();
      await expectTheme(page, theme);
      await expectNoViolations(page);
    });

    test('unread badges have no WCAG A/AA violations', async ({ page, authenticatedUser, dashboardPage, request }) => {
      // Both badge variants on the owner's dashboard: "Updated" on a note a
      // collaborator changed, "New" on one the collaborator shared with them.
      // The collaborator acts through the API on `request`, a separate
      // context, so the owner's page session is untouched.
      const collaborator = uniqueUsername('a11ybadge');
      const ok = (res: Awaited<ReturnType<typeof request.post>>) => {
        expect(res.ok(), `${res.url()} → ${res.status()}`).toBeTruthy();
        return res;
      };
      ok(await request.post('/api/v1/register', { data: { username: collaborator, password: 'testpass123' } }));
      ok(await request.post('/api/v1/login', { data: { username: collaborator, password: 'testpass123' } }));

      await dashboardPage.goto();
      await dashboardPage.createNote('A11y Updated Note');
      await dashboardPage.shareNoteWithUser('A11y Updated Note', collaborator);

      const shared = (await ok(await request.get('/api/v1/notes')).json()) as { notes: { id: string; title: string }[] };
      const updatedNote = shared.notes.find(n => n.title === 'A11y Updated Note');
      expect(updatedNote).toBeDefined();
      ok(await request.post(`/api/v1/notes/${updatedNote!.id}/items`, { data: { text: 'added by collaborator', position: 0 } }));

      const created = (await ok(await request.post('/api/v1/notes', {
        data: { note_type: 'list', title: 'A11y New Note', items: [{ text: 'item', position: 0 }] },
      })).json()) as { id: string };
      const users = (await ok(await request.get('/api/v1/users')).json()) as { users: { id: string; username: string }[] };
      const owner = users.users.find(u => u.username === authenticatedUser.username);
      expect(owner).toBeDefined();
      ok(await request.post(`/api/v1/notes/${created.id}/share`, { data: { user_id: owner!.id } }));

      await page.reload();
      await expect(dashboardPage.noteCardUnreadBadge('A11y Updated Note')).toHaveText('Updated');
      await expect(dashboardPage.noteCardUnreadBadge('A11y New Note')).toHaveText('New');
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

    test('list rows with links, and the links menu, have no WCAG A/AA violations', async ({ page, authenticatedUser, dashboardPage }) => {
      void authenticatedUser;
      await dashboardPage.goto();
      // One row per form of the open-link control: an anchor, and a menu button.
      await dashboardPage.createListNote('A11y Links Note', [
        'see [docs](https://example.com/docs)',
        '[a](https://a.example.com) or [b](https://b.example.com)',
      ]);
      await dashboardPage.openNote('A11y Links Note');
      await expect(dashboardPage.listItemOpenLink(0)).toBeVisible();
      await expectTheme(page, theme);
      await expectNoViolations(page);

      // The open menu is portalled out of the row, so it is its own scan.
      await dashboardPage.listItemOpenLink(1).click();
      await expect(page.getByRole('menu')).toBeVisible();
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

    test('note conflict banner has no WCAG A/AA violations', async ({ page, authenticatedUser, dashboardPage, noteEditorPage, noteConflictBanner }) => {
      void authenticatedUser;
      await openNoteInConflict(
        { page, dashboardPage, noteEditorPage },
        { original: 'A11y Conflict Note', mine: 'Local edit', theirs: 'Remote edit' },
      );
      await noteConflictBanner.expectVisible();
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

    // Highlighted code sits on an opaque panel whatever the note colour, which
    // is what lets one palette per theme pass everywhere — this checks that
    // claim against every colour, with every token scope on screen.
    test('highlighted code has no WCAG A/AA violations in any note colour', async ({ page, authenticatedUser, dashboardPage }) => {
      void authenticatedUser;
      test.setTimeout(120_000);
      await dashboardPage.goto();
      await dashboardPage.createTextNote(HIGHLIGHTED_CODE_NOTE);
      await dashboardPage.openTextNote('A11y code sample');
      await expectTheme(page, theme);

      const preview = '[role="dialog"] [data-testid="note-content-preview"]';
      for (const scope of CODE_SCOPES) {
        await expect(page.locator(`${preview} [data-code="${scope}"]`).first(), scope).toBeVisible();
      }

      const saveStatus = page.getByTestId('note-save-status');
      for (const colour of NOTE_COLOURS) {
        await dashboardPage.setNoteColorFromModal(colour);
        await expect(saveStatus.getByText('Saved')).toBeVisible();
        await expectNoViolations(page, { include: [preview] });
      }
    });

    test('task checkboxes in the note preview have no WCAG A/AA violations', async ({ page, authenticatedUser, dashboardPage }) => {
      void authenticatedUser;
      await dashboardPage.goto();
      await dashboardPage.createTextNote('A11y tasks\n\n- [ ] open item\n- [x] **done** item');
      await dashboardPage.openTextNote('A11y tasks');
      await expectTheme(page, theme);

      const preview = '[role="dialog"] [data-testid="note-content-preview"]';
      await expect(page.locator(`${preview} input[type="checkbox"]`)).toHaveCount(2);
      await expectNoViolations(page, { include: [preview] });
    });

    // A code line wider than the note wraps rather than scrolling: a
    // scrolling <pre> is a region keyboard users cannot reach
    // (scrollable-region-focusable), and the preview around it is itself a
    // control, so the block cannot be made a tab stop instead.
    test('a long code line has no WCAG A/AA violations', async ({ page, authenticatedUser, dashboardPage }) => {
      void authenticatedUser;
      await dashboardPage.goto();
      await dashboardPage.createTextNote(LONG_CODE_NOTE);
      await dashboardPage.openTextNote('A11y long code');
      await expectTheme(page, theme);

      // Measured on the preview, not the <pre>: a block that grew wider than
      // the note would not overflow itself, only its container.
      const preview = '[role="dialog"] [data-testid="note-content-preview"]';
      await expect(page.locator(`${preview} pre`)).toBeVisible();
      await expectNoViolations(page, { include: [preview] });
      expect(await page.locator(preview).evaluate((el) => el.scrollWidth - el.clientWidth), 'code scrolls sideways').toBeLessThanOrEqual(0);

      // Cards share the block styles; one is a single control, so a scroll
      // region inside it would be unreachable too.
      await dashboardPage.closeNoteModal();
      const card = dashboardPage.noteCardByText('A11y long code');
      await expect(card.locator('pre')).toBeVisible();
      await expectNoViolations(page, { include: ['[data-testid="note-card"]'] });
      expect(await card.locator('.markdown-content').evaluate((el) => el.scrollWidth - el.clientWidth), 'card code scrolls sideways').toBeLessThanOrEqual(0);
    });

    test('settings page has no WCAG A/AA violations', async ({ page, authenticatedUser, settingsPage }) => {
      void authenticatedUser;
      await settingsPage.goto();
      await expect(page.getByRole('heading', { name: 'Active Sessions' })).toBeVisible();
      await expectTheme(page, theme);

      await expectNoViolations(page);
    });

    test('settings diagnostics with a failed request has no WCAG A/AA violations', async ({ page, authenticatedUser, settingsPage }) => {
      void authenticatedUser;
      await settingsPage.goto();
      await settingsPage.failPATCreates('a11y0123456789ab');
      await settingsPage.createPAT('A11y token');
      await expect(settingsPage.diagnosticsFailedRequests()).toBeVisible();
      await expectTheme(page, theme);

      await expectNoViolations(page, { include: ['[data-testid="diagnostics-section"]'] });
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

    test('public note viewer has no WCAG A/AA violations', async ({ page, request, publicNotePage }) => {
      // Scanned as an anonymous visitor: the note's owner works through
      // `request`, and `page` never signs in. A list note with a nested item,
      // the completed section expanded and an image covers most of the
      // markup; the text note covers the rendered Markdown.
      await signUp(request, 'a11ypublic');
      const listId = await createListNote(request, 'A11y Public List', [
        { text: 'Parent item' },
        { text: 'Child item', indent: 1 },
        { text: 'Done child', indent: 1, completed: true },
        { text: 'Done item', completed: true },
      ]);
      const upload = await request.post(`/api/v1/notes/${listId}/images`, {
        multipart: { file: { name: 'test-icon.png', mimeType: 'image/png', buffer: noteImageBuffer } },
      });
      expect(upload.ok()).toBeTruthy();
      const listToken = await setPublicLink(request, listId);
      const textToken = await setPublicLink(request, await createTextNote(request, '# Heading\n\nSome **bold** text, a [link](https://example.com) and `code`.\n\n- [x] a task'));

      await publicNotePage.goto(listToken);
      await expect(publicNotePage.completedToggle()).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('img', { name: 'Image 1' })).toBeVisible();
      await expectTheme(page, theme);
      await expectNoViolations(page);

      await publicNotePage.goto(textToken);
      await expect(publicNotePage.content().locator('strong')).toHaveText('bold');
      await expectNoViolations(page);

      await publicNotePage.goto('A'.repeat(43));
      await expect(publicNotePage.notFound()).toBeVisible();
      await expectNoViolations(page);
    });

    test('share dialog with a public link has no WCAG A/AA violations', async ({ page, authenticatedUser, dashboardPage, publicLinkSection }) => {
      void authenticatedUser;
      await dashboardPage.goto();
      await dashboardPage.createNote('A11y Public Link Note');
      await dashboardPage.openNote('A11y Public Link Note');
      await dashboardPage.openShareModalFromModal();
      await expect(publicLinkSection.createButton()).toBeVisible();
      await expectTheme(page, theme);
      await expectNoViolations(page, { include: ['[data-testid="public-link-section"]'] });

      await publicLinkSection.create('In 30 days');
      await expect(publicLinkSection.details()).toContainText('Created by you');
      await expectNoViolations(page, { include: ['[data-testid="public-link-section"]'] });

      // The open expiry editor.
      await publicLinkSection.changeButton().click();
      await expect(publicLinkSection.newExpirySelect()).toBeFocused();
      await expectNoViolations(page, { include: ['[data-testid="public-link-section"]'] });
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
