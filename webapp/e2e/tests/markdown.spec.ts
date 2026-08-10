import { test, expect } from '../fixtures';

test.describe('Markdown note editing', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    // Ensure we're logged in for every test in this suite
    void authenticatedUser;
  });

  test('markdown renders in note card after saving', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    // Text notes have content (not title); create one with markdown content.
    await dashboardPage.createTextNote('**bold text**');

    // Find the card by its rendered content text.
    const card = dashboardPage.noteCardByText('bold text');
    // Card content should render as <strong>, not raw **
    await expect(card.locator('strong')).toHaveText('bold text');
    await expect(card).not.toContainText('**bold text**');
  });

  test('preview renders markdown and clicking enters edit mode', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    // Intentionally keep the modal open after creation to test in-modal interactions,
    // so we bypass dashboardPage.createNote() which closes the dialog before returning.
    await dashboardPage.clickNewNote();
    // Text notes have no title input; fill content directly.
    await page.fill('textarea[placeholder="Take a note..."]', '## Heading');

    // Escape collapses the content area from edit mode to preview (modal stays open)
    await page.keyboard.press('Escape');

    const dialog = page.getByRole('dialog');
    const preview = dialog.getByTestId('note-content-preview');
    await expect(preview).toBeVisible();
    await expect(preview.locator('h2')).toBeVisible();
    await expect(dialog.locator('textarea[placeholder="Take a note..."]')).toHaveCount(0);

    // Clicking the preview div re-enters edit mode
    await preview.click();
    await expect(dialog.locator('textarea[placeholder="Take a note..."]')).toBeVisible();

    await dialog.getByRole('button', { name: 'Close' }).click();
  });

  // The full feature set is specified in docs/specs/markdown-rendering.md and
  // pinned per-construct by the unit tests on both clients; these two cover it
  // end to end, on real note content, in the browser.
  test('renders the supported syntax in the preview', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.clickNewNote();
    await page.fill(
      'textarea[placeholder="Take a note..."]',
      [
        '### Third heading',
        '',
        '#### Fourth heading',
        '',
        '**bold** and ~~struck~~',
        '',
        '- [x] done',
        '- [ ] todo',
        '',
        '```',
        'const a = 1;',
        '```',
        '',
        '---',
        '',
        'visit https://example.com now',
      ].join('\n'),
    );
    await page.keyboard.press('Escape');

    const preview = page.getByRole('dialog').getByTestId('note-content-preview');
    await expect(preview.locator('h3')).toHaveText('Third heading');
    // h4 and below are headings, but sized as bold body text.
    await expect(preview.locator('h4')).toHaveText('Fourth heading');
    const bodySize = await preview.locator('p').first().evaluate((el) => getComputedStyle(el).fontSize);
    await expect(preview.locator('h4')).toHaveCSS('font-size', bodySize);
    await expect(preview.locator('h4')).toHaveCSS('font-weight', '700');
    await expect(preview.locator('strong')).toHaveText('bold');
    await expect(preview.locator('del')).toHaveText('struck');
    await expect(preview.locator('li').nth(0)).toHaveText('☑ done');
    await expect(preview.locator('li').nth(1)).toHaveText('☐ todo');
    // Checkboxes are glyphs, not inputs — nothing to toggle.
    await expect(preview.locator('input')).toHaveCount(0);
    await expect(preview.locator('pre')).toContainText('const a = 1;');
    await expect(preview.locator('hr')).toHaveCount(1);
    await expect(preview.locator('a[href="https://example.com"]')).toBeVisible();
  });

  test('shows unsupported syntax as literal source and refuses unsupported link schemes', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.clickNewNote();
    await page.fill(
      'textarea[placeholder="Take a note..."]',
      [
        '![alt](https://example.com/y.png)',
        '',
        'a | b',
        '--- | ---',
        '1 | 2',
        '',
        '[call](tel:+15550100)',
      ].join('\n'),
    );
    await page.keyboard.press('Escape');

    const preview = page.getByRole('dialog').getByTestId('note-content-preview');
    await expect(preview).toContainText('![alt](https://example.com/y.png)');
    await expect(preview.locator('img')).toHaveCount(0);
    await expect(preview).toContainText('a | b');
    await expect(preview.locator('table')).toHaveCount(0);
    // tel: renders as its label, with nothing to follow.
    await expect(preview).toContainText('call');
    await expect(preview.locator('a')).toHaveCount(0);
  });

  // List-item text renders the inline subset (docs/specs/markdown-rendering.md
  // §2.1). The card is the display surface; the editor row deliberately still
  // shows source, which is what the second test below pins.
  test('renders the inline subset in list-note item text on the card', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createListNote('Shopping', [
      'buy **milk** and *bread*',
      '~~cancelled~~ item',
      'run `npm ci`',
      'see https://example.com',
      '[docs](https://example.com/docs)',
    ]);

    const card = dashboardPage.noteCardByText('Shopping');
    await expect(card.locator('strong')).toHaveText('milk');
    await expect(card.locator('em')).toHaveText('bread');
    await expect(card.locator('del')).toHaveText('cancelled');
    await expect(card.locator('code')).toHaveText('npm ci');
    // The source markers are gone, not merely restyled.
    await expect(card).not.toContainText('**milk**');

    // Links are the one construct a card does not render as a link: the card is
    // itself the control that opens the note, so an anchor here would follow the
    // link *and* open the note. The label survives as text
    // (docs/specs/markdown-rendering.md §1).
    await expect(card.locator('a')).toHaveCount(0);
    await expect(card).toContainText('https://example.com');
    await expect(card).toContainText('docs');
  });

  test('renders links as text on a card and as links in the note body', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createTextNote('read the [docs](https://example.com/docs) first');

    // Same note, two surfaces: the card is a control, the open note is not.
    const card = dashboardPage.noteCardByText('read the');
    await expect(card.locator('a')).toHaveCount(0);
    await expect(card).toContainText('read the docs first');

    await card.click();
    const preview = page.getByRole('dialog').getByTestId('note-content-preview');
    await expect(preview.locator('a[href="https://example.com/docs"]')).toHaveText('docs');
  });

  test('leaves block syntax literal in list items and keeps the editor row showing source', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createListNote('Literal', [
      '# not a heading',
      '- [ ] not a checkbox',
      '[call](tel:+15550100)',
    ]);

    // An item is already a list item, so block syntax has nothing to describe.
    const card = dashboardPage.noteCardByText('Literal');
    await expect(card).toContainText('# not a heading');
    await expect(card).toContainText('- [ ] not a checkbox');
    await expect(card.locator('h1')).toHaveCount(0);
    // tel: renders as its label, with nothing to follow.
    await expect(card).toContainText('call');
    await expect(card.locator('a')).toHaveCount(0);

    // The editable row renders Markdown now (§1.2), and these three cases show
    // the two halves of that. Literal source renders as itself, so those rows
    // never swap at all and the field is what is on screen.
    await dashboardPage.openNote('Literal');
    await dashboardPage.expectListItemValue(0, '# not a heading');
    await expect(dashboardPage.listItemRow(0).getByTestId('list-item-rendered')).toHaveCount(0);
    await expect(dashboardPage.listItemRow(1).getByTestId('list-item-rendered')).toHaveCount(0);

    // A link Jot will not follow does not: it keeps its label and loses its
    // target (§3), so the rendered form differs from the source and the row
    // swaps like any other. The `tel:` URL is in the field, one click away.
    await expect(dashboardPage.listItemRow(2).getByTestId('list-item-rendered')).toHaveText('call');
    await expect(dashboardPage.listItemRow(2).locator('a')).toHaveCount(0);
    await dashboardPage.expectListItemValue(2, '[call](tel:+15550100)');
  });

  test('two-step Escape dismiss: first Escape collapses to preview, second Escape closes modal', async ({ page, dashboardPage }) => {
    await dashboardPage.goto();
    // Intentionally keep the modal open — see comment in previous test.
    await dashboardPage.clickNewNote();
    // Text notes have no title input; fill content directly.
    await page.fill('textarea[placeholder="Take a note..."]', 'Some content');

    const dialog = page.getByRole('dialog');
    const textarea = dialog.locator('textarea[placeholder="Take a note..."]');
    await expect(textarea).toBeVisible();

    // First Escape: textarea's onKeyDown collapses to preview; modal stays open
    await textarea.focus();
    await page.keyboard.press('Escape');

    await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
    await expect(textarea).toHaveCount(0);
    await expect(dialog.getByTestId('note-content-preview')).toBeVisible();

    // Second Escape: isEditingContent is now false, so onClose closes the modal
    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
  test.describe('formatting toolbar', () => {
    test.beforeEach(async ({ dashboardPage, noteEditorPage }) => {
      await dashboardPage.goto();
      await noteEditorPage.openNewNote();
    });

    test('bolds the selection and leaves the caret inside the markers', async ({ noteEditorPage }) => {
      await noteEditorPage.setContent('hello world');
      await noteEditorPage.selectRange(6, 11);

      await noteEditorPage.clickFormat('bold');
      await noteEditorPage.expectContent('hello **world**');

      // Still selected, so a second press toggles it back off.
      await noteEditorPage.clickFormat('bold');
      await noteEditorPage.expectContent('hello world');
    });

    test('applies every button, and the result renders in the preview', async ({ noteEditorPage }) => {
      await noteEditorPage.setContent('note');
      await noteEditorPage.selectRange(0, 4);
      await noteEditorPage.clickFormat('strikethrough');
      await noteEditorPage.expectContent('~~note~~');

      await noteEditorPage.collapseToPreview();
      await expect(noteEditorPage.preview().locator('del')).toHaveText('note');
    });

    test('cycles headings and toggles list markers', async ({ noteEditorPage }) => {
      await noteEditorPage.setContent('title');
      await noteEditorPage.selectRange(0, 0);

      await noteEditorPage.clickFormat('heading');
      await noteEditorPage.expectContent('## title');
      await noteEditorPage.clickFormat('heading');
      await noteEditorPage.expectContent('### title');
      // Capped at h3 — a fourth level would render as body text (§2 of the spec).
      await noteEditorPage.clickFormat('heading');
      await noteEditorPage.expectContent('title');

      await noteEditorPage.clickFormat('bullet');
      await noteEditorPage.expectContent('- title');
      await noteEditorPage.clickFormat('checkbox');
      await noteEditorPage.expectContent('- [ ] title');
    });

    test('keeps focus in the textarea when a button is clicked', async ({ noteEditorPage }) => {
      await noteEditorPage.setContent('hello');
      await noteEditorPage.selectRange(0, 5);

      await noteEditorPage.clickFormat('italic');

      await expect(noteEditorPage.textarea()).toBeFocused();
    });

    test('Ctrl+B and Ctrl+I format the selection', async ({ page, noteEditorPage }) => {
      await noteEditorPage.setContent('hello world');

      await noteEditorPage.selectRange(6, 11);
      await page.keyboard.press('Control+b');
      await noteEditorPage.expectContent('hello **world**');

      await noteEditorPage.selectRange(0, 5);
      await page.keyboard.press('Control+i');
      await noteEditorPage.expectContent('*hello* **world**');
    });

    test('leaves Ctrl+Shift+B to the browser', async ({ page, noteEditorPage }) => {
      await noteEditorPage.setContent('hello world');
      await noteEditorPage.selectRange(6, 11);

      await page.keyboard.press('Control+Shift+b');

      await noteEditorPage.expectContent('hello world');
    });

    // The reason applyTextareaEdit replays edits through the DOM instead of
    // writing straight to React state. Setting the value directly empties the
    // browser's undo stack, so a toolbar press would silently discard
    // everything typed before it. Only a real browser can catch that.
    test('a toolbar edit is undoable, and undo continues into earlier typing', async ({ page, noteEditorPage }) => {
      await noteEditorPage.textarea().pressSequentially('hello world');

      await noteEditorPage.selectRange(6, 11);
      await noteEditorPage.clickFormat('bold');
      await noteEditorPage.expectContent('hello **world**');

      await noteEditorPage.textarea().focus();
      await page.keyboard.press('Control+z');
      await noteEditorPage.expectContent('hello world');

      await page.keyboard.press('Control+y');
      await noteEditorPage.expectContent('hello **world**');
    });

    test('Enter carries a list marker onto the next line and clears it on an empty item', async ({ page, noteEditorPage }) => {
      await noteEditorPage.textarea().pressSequentially('- one');
      await page.keyboard.press('Enter');
      await noteEditorPage.expectContent('- one\n- ');

      await noteEditorPage.textarea().pressSequentially('two');
      await page.keyboard.press('Enter');
      await noteEditorPage.expectContent('- one\n- two\n- ');

      // Enter on the empty item ends the list instead of adding another marker.
      await page.keyboard.press('Enter');
      await noteEditorPage.expectContent('- one\n- two\n');
    });
  });

  test('formatting toolbar is not shown for a read-only binned note', async ({ page, dashboardPage, noteEditorPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createTextNote('to be binned');

    // The DashboardPage menu helpers locate cards by their h3 title, which text
    // notes do not have, so drive the card menu by content text here.
    const card = dashboardPage.noteCardByText('to be binned');
    await card.getByRole('button', { name: 'Note options' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Delete' }).click();

    await dashboardPage.switchToBin();
    await dashboardPage.noteCardByText('to be binned').click();

    // Binned notes open read-only, so there is no textarea to format.
    await expect(noteEditorPage.preview()).toBeVisible();
    await expect(noteEditorPage.toolbar()).toHaveCount(0);
  });
});

/**
 * The view/edit swap on a list-item row (docs/specs/markdown-rendering.md §1.2).
 *
 * This is the half the unit tests cannot reach: whether a click lands the caret
 * where the user pointed, and whether the row keeps its size across the swap.
 * Both need a real layout engine.
 */
test.describe('Markdown in list-item rows', () => {
  test.beforeEach(async ({ authenticatedUser }) => {
    void authenticatedUser;
  });

  test('renders an item when it loses focus and shows source when clicked', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createListNote('Render Row Note', ['buy **milk**']);
    await dashboardPage.openNote('Render Row Note');

    // Unfocused: the markers are gone and the word is really bold.
    await expect(dashboardPage.listItemRendered(0)).toBeVisible();
    await expect(dashboardPage.listItemRendered(0).locator('strong')).toHaveText('milk');
    await expect(dashboardPage.listItemRendered(0)).toHaveText('buy milk');

    // Clicking it hands over to the field, which holds the source.
    await dashboardPage.listItemRendered(0).click();
    await expect(dashboardPage.listItemInput(0)).toBeFocused();
    await expect(dashboardPage.listItemRendered(0)).toHaveCount(0);
    await dashboardPage.expectListItemValue(0, 'buy **milk**');

    // And moving away renders it again — the acceptance criterion on #824.
    await dashboardPage.listItemInput(0).blur();
    await expect(dashboardPage.listItemRendered(0)).toBeVisible();
  });

  test('puts the caret where the rendered text was clicked', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createListNote('Caret Note', ['buy **milk** today']);
    await dashboardPage.openNote('Caret Note');

    const caret = () => dashboardPage.listItemInput(0).evaluate(
      (el: HTMLTextAreaElement) => el.selectionStart,
    );

    // Clicking the middle of the bold word must land inside `milk` in the
    // source — offsets 6..10 of `buy **milk** today`. Without the mapping this
    // is 0 (a bare focus()) or 18 (the end), so the assertion has real teeth.
    await dashboardPage.listItemRendered(0).locator('strong').click();
    expect(await caret()).toBeGreaterThanOrEqual(6);
    expect(await caret()).toBeLessThanOrEqual(10);

    // And a click before the markers stays before them.
    await dashboardPage.listItemInput(0).blur();
    await dashboardPage.listItemRendered(0).click({ position: { x: 2, y: 8 } });
    expect(await caret()).toBeLessThan(4);
  });

  test('keeps the row the same height across the swap', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    // The code row is here because it is the one that regressed: `<code>` sets
    // its own font, and an inline box in a different font sits at a different
    // offset around the shared baseline, so it grew the rendered line box past
    // the strut while the all-one-font source stayed put. Sub-pixel on some
    // fonts, visible on others — a row that only jumps for some readers is
    // exactly what a test has to hold down.
    await dashboardPage.createListNote('Height Note', [
      'buy **milk**',
      'run `npm test` first',
      'second item',
    ]);
    await dashboardPage.openNote('Height Note');

    for (const index of [0, 1]) {
      const row = dashboardPage.listItemRow(index);
      const renderedHeight = (await row.boundingBox())!.height;

      await dashboardPage.listItemRendered(index).click();
      await expect(dashboardPage.listItemInput(index)).toBeFocused();
      const sourceHeight = (await row.boundingBox())!.height;

      // Both forms are one line here, and they carry the same padding and
      // wrapping, so the row must not resize at all. A regression in
      // TEXT_LAYOUT_CLASSES, or in the inline styling of a rendered child,
      // shows up here as a fraction of a pixel either way.
      expect(Math.abs(sourceHeight - renderedHeight), `row ${index}`).toBeLessThan(0.5);
      await dashboardPage.listItemInput(index).blur();
    }
  });

  test('leaves an item with no Markdown as a live field', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createListNote('Plain Note', ['buy milk']);
    await dashboardPage.openNote('Plain Note');

    // Nothing to render that the field is not already showing, so the row never
    // swaps and typing into it is exactly what it was before #824.
    await expect(dashboardPage.listItemRendered(0)).toHaveCount(0);
    await expect(dashboardPage.listItemInput(0)).toBeVisible();
  });

  test('renders a completed item, line-through and all', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createListNote('Completed Note', ['buy **milk**']);
    await dashboardPage.openNote('Completed Note');

    await dashboardPage.listItemRow(0)
      .getByRole('checkbox', { name: 'Item completed' }).check();

    await expect(dashboardPage.listItemRendered(0).locator('strong')).toHaveText('milk');
  });

  test('does not make a link out of an editable row', async ({ dashboardPage }) => {
    await dashboardPage.goto();
    await dashboardPage.createListNote('Link Row Note', ['see [docs](https://example.com)']);
    await dashboardPage.openNote('Link Row Note');

    // One click on the row already means "put the caret here" — see §1.2. The
    // label survives, the target does not, and nothing looks followable.
    await expect(dashboardPage.listItemRendered(0)).toHaveText('see docs');
    await expect(dashboardPage.listItemRendered(0).locator('a')).toHaveCount(0);
  });

  test.describe('formatting toolbar', () => {
    test('appears with the row that has the caret and carries only the inline actions', async ({ page, dashboardPage, noteEditorPage }) => {
      await dashboardPage.goto();
      await dashboardPage.createListNote('Item Toolbar Note', ['buy milk']);
      await dashboardPage.openNote('Item Toolbar Note');

      // Nothing focused yet, so there is no row for a button to act on. The bar
      // keeps its slot (the modal is centred, and a bar that came and went
      // would shift the rows), but it is hidden and unreachable.
      await expect(noteEditorPage.toolbar()).not.toBeVisible();

      await dashboardPage.focusListItem(0);
      await expect(noteEditorPage.toolbar()).toBeVisible();

      // The inline three, and only those: an item is lexed as inline content,
      // so a heading/bullet/checkbox button would write literal source (§2.1).
      for (const action of ['bold', 'italic', 'strikethrough'] as const) {
        await expect(noteEditorPage.formatButton(action)).toBeVisible();
      }
      for (const action of ['heading', 'bullet', 'checkbox'] as const) {
        await expect(noteEditorPage.formatButton(action)).toHaveCount(0);
      }

      // aria-controls names the row it is editing.
      const rowId = await dashboardPage.listItemInput(0).getAttribute('id');
      expect(rowId).toBeTruthy();
      await expect(noteEditorPage.toolbar()).toHaveAttribute('aria-controls', rowId!);

      // Focus somewhere outside the list and the bar hides again.
      await page.getByPlaceholder('Title').click();
      await expect(noteEditorPage.toolbar()).not.toBeVisible();
    });

    test('stays on screen on a list taller than the modal', async ({ dashboardPage, noteEditorPage }) => {
      await dashboardPage.goto();
      await dashboardPage.createListNote(
        'Long List Note',
        Array.from({ length: 25 }, (_, i) => `Item ${i + 1}`),
      );
      await dashboardPage.openNote('Long List Note');
      await dashboardPage.focusListItem(0);

      // The bar is docked to the modal chrome, not laid out in the scrolling
      // body: editing the top row of a long list must not leave the buttons
      // hundreds of pixels below the viewport, which is what an in-flow bar did.
      await expect(noteEditorPage.toolbar()).toBeInViewport();
    });

    test('bolds the selection, keeps focus on the row, and renders once it blurs', async ({ dashboardPage, noteEditorPage }) => {
      await dashboardPage.goto();
      await dashboardPage.createListNote('Item Bold Note', ['buy milk']);
      await dashboardPage.openNote('Item Bold Note');

      await dashboardPage.selectListItemRange(0, 4, 8); // "milk"
      await noteEditorPage.clickFormat('bold');

      await dashboardPage.expectListItemValue(0, 'buy **milk**');
      // The press must not have moved focus: a blur would have swapped the row
      // back to its rendered form mid-edit, and dropped the selection with it.
      await expect(dashboardPage.listItemInput(0)).toBeFocused();

      await dashboardPage.listItemInput(0).blur();
      await expect(dashboardPage.listItemRendered(0).locator('strong')).toHaveText('milk');
    });

    test('a toolbar edit on a row is undoable', async ({ page, dashboardPage, noteEditorPage }) => {
      await dashboardPage.goto();
      await dashboardPage.createListNote('Item Undo Note', ['buy milk']);
      await dashboardPage.openNote('Item Undo Note');

      await dashboardPage.selectListItemRange(0, 4, 8);
      await noteEditorPage.clickFormat('bold');
      await dashboardPage.expectListItemValue(0, 'buy **milk**');

      // Replayed through the DOM rather than assigned, so the browser's own
      // undo stack survives it — see webapp/src/utils/textareaEdit.ts.
      await page.keyboard.press('ControlOrMeta+z');
      await dashboardPage.expectListItemValue(0, 'buy milk');
    });

    test('is not shown on a read-only binned note', async ({ dashboardPage, noteEditorPage }) => {
      await dashboardPage.goto();
      await dashboardPage.createListNote('Binned List Note', ['buy milk']);
      await dashboardPage.deleteNote('Binned List Note');

      await dashboardPage.switchToBin();
      await dashboardPage.openNote('Binned List Note');

      // A binned row has no caret to place, so there is nothing to format.
      await expect(noteEditorPage.toolbar()).toHaveCount(0);
    });
  });
});
