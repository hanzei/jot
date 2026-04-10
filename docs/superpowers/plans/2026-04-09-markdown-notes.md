# Markdown Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add markdown rendering to text notes — render on blur, edit raw markdown on focus, with a lightweight formatting toolbar.

**Architecture:** A `renderMarkdown` utility (marked + DOMPurify) is shared across NoteCard and NoteModal in the webapp. NoteModal gains an `isEditingContent` boolean state that switches between a rendered `<div>` and the existing `<textarea>`. The mobile NoteEditorScreen follows the same pattern using `react-native-markdown-display` and `Keyboard` listeners.

**Tech Stack:** `marked` (markdown parsing), `dompurify` (XSS sanitization), `react-native-markdown-display` (mobile rendering), existing Tailwind CSS, existing i18n infrastructure.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `webapp/src/utils/markdown.ts` | `renderMarkdown(content): string` — parse + sanitize |
| Create | `webapp/src/utils/__tests__/markdown.test.ts` | Unit tests for renderer |
| Modify | `webapp/src/components/NoteCard.tsx` | Render markdown in text note card preview |
| Modify | `webapp/src/components/__tests__/NoteCard.test.tsx` | Test card markdown rendering |
| Modify | `webapp/src/i18n/locales/en.json` + 7 other locales | Add formatting toolbar i18n keys |
| Modify | `webapp/src/components/NoteModal.tsx` | `isEditingContent` state, preview div, toolbar helpers, Dialog onClose interception |
| Modify | `webapp/src/components/__tests__/NoteModal.test.tsx` | Test edit/preview toggle and toolbar |
| Create | `webapp/e2e/tests/markdown.spec.ts` | E2E: create note with markdown, verify render |
| Modify | `mobile/package.json` | Add `react-native-markdown-display` |
| Modify | `mobile/src/i18n/locales/en.json` + 7 other locales | Add formatting toolbar i18n keys |
| Modify | `mobile/src/screens/NoteEditorScreen.tsx` | `isEditingContent` state, markdown preview, Done button, formatting toolbar |

---

## Task 1: Install webapp dependencies and create markdown renderer

**Files:**
- Create: `webapp/src/utils/markdown.ts`
- Create: `webapp/src/utils/__tests__/markdown.test.ts`

- [ ] **Step 1: Install marked and dompurify**

```bash
cd webapp && npm install marked dompurify && npm install --save-dev @types/dompurify
```

Expected: packages added to `webapp/package.json`, no errors.

- [ ] **Step 2: Write failing tests for the renderer**

Create `webapp/src/utils/__tests__/markdown.test.ts`:

```typescript
import { renderMarkdown } from '../markdown';

describe('renderMarkdown', () => {
  it('renders bold', () => {
    expect(renderMarkdown('**hello**')).toContain('<strong>hello</strong>');
  });

  it('renders italic', () => {
    expect(renderMarkdown('*hello*')).toContain('<em>hello</em>');
  });

  it('renders h2 heading', () => {
    expect(renderMarkdown('## Title')).toContain('<h2>');
    expect(renderMarkdown('## Title')).toContain('Title');
  });

  it('renders unordered list', () => {
    expect(renderMarkdown('- item')).toContain('<li>');
    expect(renderMarkdown('- item')).toContain('item');
  });

  it('renders blockquote', () => {
    expect(renderMarkdown('> quote')).toContain('<blockquote>');
  });

  it('renders inline code', () => {
    expect(renderMarkdown('`code`')).toContain('<code>code</code>');
  });

  it('renders link with safe attributes', () => {
    const result = renderMarkdown('[text](https://example.com)');
    expect(result).toContain('<a');
    expect(result).toContain('text');
    expect(result).toContain('noopener noreferrer');
  });

  it('strips script tags', () => {
    const result = renderMarkdown('<script>alert(1)</script>');
    expect(result).not.toContain('<script>');
  });

  it('strips onclick attributes', () => {
    const result = renderMarkdown('<a onclick="evil()">link</a>');
    expect(result).not.toContain('onclick');
  });

  it('returns empty string for blank input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   ')).toBe('');
  });

  it('plain text passes through safely', () => {
    expect(renderMarkdown('hello world')).toContain('hello world');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd webapp && npx vitest run src/utils/__tests__/markdown.test.ts
```

Expected: FAIL — `Cannot find module '../markdown'`.

- [ ] **Step 4: Implement the renderer**

Create `webapp/src/utils/markdown.ts`:

```typescript
import { marked, Renderer } from 'marked';
import DOMPurify from 'dompurify';

const renderer = new Renderer();

renderer.link = ({ href, text }: { href: string; text: string }) =>
  `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

marked.use({ renderer, breaks: true, gfm: true });

const ALLOWED_TAGS = [
  'p', 'br', 'h2', 'h3',
  'strong', 'em',
  'ul', 'ol', 'li',
  'blockquote', 'code',
  'a',
];
const ALLOWED_ATTR = ['href', 'target', 'rel'];

export function renderMarkdown(content: string): string {
  if (!content.trim()) return '';
  const raw = marked(content) as string;
  return DOMPurify.sanitize(raw, { ALLOWED_TAGS, ALLOWED_ATTR });
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd webapp && npx vitest run src/utils/__tests__/markdown.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add webapp/src/utils/markdown.ts webapp/src/utils/__tests__/markdown.test.ts webapp/package.json webapp/package-lock.json
git commit -m "feat: add renderMarkdown utility with XSS sanitization"
```

---

## Task 2: Render markdown in NoteCard

**Files:**
- Modify: `webapp/src/components/NoteCard.tsx:316-319`
- Modify: `webapp/src/components/__tests__/NoteCard.test.tsx`

- [ ] **Step 1: Write a failing test**

Open `webapp/src/components/__tests__/NoteCard.test.tsx`. Find the existing test that renders a text note content and add:

```typescript
it('renders markdown in text note content', () => {
  const note = makeNote({ note_type: 'text', content: '**bold text**' });
  render(<NoteCard note={note} onEdit={vi.fn()} onDelete={vi.fn()} />);
  // The rendered HTML should contain <strong>, not raw **
  const card = screen.getByTestId('note-card');
  expect(card.innerHTML).toContain('<strong>bold text</strong>');
  expect(card.innerHTML).not.toContain('**bold text**');
});
```

Note: `makeNote` is whatever factory helper already exists in this test file — adapt to match the existing pattern.

- [ ] **Step 2: Run to verify it fails**

```bash
cd webapp && npx vitest run src/components/__tests__/NoteCard.test.tsx
```

Expected: FAIL — content renders as raw text.

- [ ] **Step 3: Import renderMarkdown and update the content div**

In `webapp/src/components/NoteCard.tsx`, add the import at the top:

```typescript
import { renderMarkdown } from '@/utils/markdown';
```

Find the text note content block (around line 316):

```tsx
// BEFORE:
{note.note_type === 'text' ? (
  <div className="text-sm text-gray-700 dark:text-gray-200 line-clamp-6 whitespace-pre-wrap">
    {note.content}
  </div>
```

Replace with:

```tsx
// AFTER:
{note.note_type === 'text' ? (
  <div
    className="text-sm text-gray-700 dark:text-gray-200 line-clamp-6 markdown-content"
    dangerouslySetInnerHTML={{ __html: renderMarkdown(note.content) || note.content }}
  />
```

The `|| note.content` fallback ensures plain-text-only notes (no markdown syntax) still display if `renderMarkdown` ever returns empty for non-empty content.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd webapp && npx vitest run src/components/__tests__/NoteCard.test.tsx
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add webapp/src/components/NoteCard.tsx webapp/src/components/__tests__/NoteCard.test.tsx
git commit -m "feat: render markdown in note card preview"
```

---

## Task 3: Add i18n keys for formatting toolbar (webapp)

**Files:**
- Modify: `webapp/src/i18n/locales/en.json`
- Modify: `webapp/src/i18n/locales/de.json`
- Modify: `webapp/src/i18n/locales/es.json`
- Modify: `webapp/src/i18n/locales/fr.json`
- Modify: `webapp/src/i18n/locales/it.json`
- Modify: `webapp/src/i18n/locales/nl.json`
- Modify: `webapp/src/i18n/locales/pl.json`
- Modify: `webapp/src/i18n/locales/pt.json`

- [ ] **Step 1: Add keys to en.json**

In `webapp/src/i18n/locales/en.json`, add inside the `"note"` object:

```json
"formatBold": "Bold",
"formatItalic": "Italic",
"formatHeading": "Heading",
"formatBulletList": "Bullet list"
```

- [ ] **Step 2: Add translations to all other locale files**

`de.json`:
```json
"formatBold": "Fett",
"formatItalic": "Kursiv",
"formatHeading": "Überschrift",
"formatBulletList": "Aufzählung"
```

`es.json`:
```json
"formatBold": "Negrita",
"formatItalic": "Cursiva",
"formatHeading": "Encabezado",
"formatBulletList": "Lista de viñetas"
```

`fr.json`:
```json
"formatBold": "Gras",
"formatItalic": "Italique",
"formatHeading": "Titre",
"formatBulletList": "Liste à puces"
```

`it.json`:
```json
"formatBold": "Grassetto",
"formatItalic": "Corsivo",
"formatHeading": "Intestazione",
"formatBulletList": "Elenco puntato"
```

`nl.json`:
```json
"formatBold": "Vet",
"formatItalic": "Cursief",
"formatHeading": "Kop",
"formatBulletList": "Opsommingsteken"
```

`pl.json`:
```json
"formatBold": "Pogrubienie",
"formatItalic": "Kursywa",
"formatHeading": "Nagłówek",
"formatBulletList": "Lista punktowana"
```

`pt.json`:
```json
"formatBold": "Negrito",
"formatItalic": "Itálico",
"formatHeading": "Título",
"formatBulletList": "Lista de marcadores"
```

- [ ] **Step 3: Verify locale files are in sync**

```bash
cd /path/to/repo && task check-translations
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add webapp/src/i18n/locales/
git commit -m "feat: add i18n keys for markdown formatting toolbar (webapp)"
```

---

## Task 4: Add render-on-blur editing to NoteModal

**Files:**
- Modify: `webapp/src/components/NoteModal.tsx`
- Modify: `webapp/src/components/__tests__/NoteModal.test.tsx`

This is the largest change. Read through all steps before starting.

- [ ] **Step 1: Write failing tests**

In `webapp/src/components/__tests__/NoteModal.test.tsx`, add:

```typescript
describe('markdown editing in text notes', () => {
  it('renders markdown in preview mode by default for existing notes', async () => {
    const note = makeNote({ note_type: 'text', content: '**bold**' });
    render(<NoteModal note={note} onClose={vi.fn()} onSave={vi.fn()} />);
    const preview = screen.getByTestId('note-content-preview');
    expect(preview.innerHTML).toContain('<strong>bold</strong>');
  });

  it('switches to textarea when preview is clicked', async () => {
    const note = makeNote({ note_type: 'text', content: '**bold**' });
    render(<NoteModal note={note} onClose={vi.fn()} onSave={vi.fn()} />);
    const preview = screen.getByTestId('note-content-preview');
    await userEvent.click(preview);
    expect(screen.getByRole('textbox', { name: /content/i })).toBeInTheDocument();
  });

  it('collapses to preview on Escape', async () => {
    const note = makeNote({ note_type: 'text', content: '**bold**' });
    render(<NoteModal note={note} onClose={vi.fn()} onSave={vi.fn()} />);
    await userEvent.click(screen.getByTestId('note-content-preview'));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('note-content-preview')).toBeInTheDocument();
  });

  it('shows formatting toolbar when editing', async () => {
    const note = makeNote({ note_type: 'text', content: '' });
    render(<NoteModal note={note} onClose={vi.fn()} onSave={vi.fn()} />);
    await userEvent.click(screen.getByTestId('note-content-preview'));
    expect(screen.getByRole('button', { name: /bold/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /italic/i })).toBeInTheDocument();
  });

  it('hides formatting toolbar in preview mode', () => {
    const note = makeNote({ note_type: 'text', content: '**bold**' });
    render(<NoteModal note={note} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /bold/i })).not.toBeInTheDocument();
  });
});
```

Note: `makeNote` should match whatever factory helper the file already uses. Add `import userEvent from '@testing-library/user-event'` if not already imported.

- [ ] **Step 2: Run to verify they fail**

```bash
cd webapp && npx vitest run src/components/__tests__/NoteModal.test.tsx
```

Expected: FAIL — `note-content-preview` not found.

- [ ] **Step 3: Add isEditingContent state and cursor-restore ref**

In `webapp/src/components/NoteModal.tsx`, find the state declarations (around line 384) and add:

```typescript
const [isEditingContent, setIsEditingContent] = useState(false);
const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null);
```

- [ ] **Step 4: Initialize isEditingContent when note loads**

Find the `useEffect` that initializes state from `existingNote` (it sets `title`, `content`, `noteType`, etc.). Add at the end of that effect:

```typescript
// Start in edit mode for new notes; preview mode for existing notes
setIsEditingContent(!note);
```

- [ ] **Step 5: Add useEffect to restore cursor after toolbar operations**

After the existing `useEffect` blocks, add:

```typescript
useEffect(() => {
  if (pendingSelectionRef.current && contentRef.current) {
    const { start, end } = pendingSelectionRef.current;
    contentRef.current.focus();
    contentRef.current.setSelectionRange(start, end);
    pendingSelectionRef.current = null;
  }
}, [content]);
```

- [ ] **Step 6: Add toolbar helper functions**

Before the `return` statement, add:

```typescript
const wrapContentSelection = useCallback((before: string, after: string) => {
  const textarea = contentRef.current;
  if (!textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = content.slice(start, end);
  const replacement = before + (selected || 'text') + after;
  const newContent = content.slice(0, start) + replacement + content.slice(end);
  setContent(newContent);
  pendingSelectionRef.current = {
    start: start + before.length,
    end: start + before.length + (selected || 'text').length,
  };
}, [content]);

const insertContentHeading = useCallback(() => {
  const textarea = contentRef.current;
  if (!textarea) return;
  const pos = textarea.selectionStart;
  const lineStart = content.lastIndexOf('\n', pos - 1) + 1;
  const line = content.slice(lineStart, content.indexOf('\n', pos) === -1 ? undefined : content.indexOf('\n', pos));
  if (line.startsWith('## ')) return;
  const newContent = content.slice(0, lineStart) + '## ' + content.slice(lineStart);
  setContent(newContent);
  pendingSelectionRef.current = { start: pos + 3, end: pos + 3 };
}, [content]);

const insertContentBullet = useCallback(() => {
  const textarea = contentRef.current;
  if (!textarea) return;
  const pos = textarea.selectionStart;
  const before = content.slice(0, pos);
  const insert = (before.endsWith('\n') || before === '') ? '- ' : '\n- ';
  const newContent = before + insert + content.slice(pos);
  setContent(newContent);
  pendingSelectionRef.current = { start: pos + insert.length, end: pos + insert.length };
}, [content]);
```

- [ ] **Step 7: Import renderMarkdown**

At the top of `NoteModal.tsx`, add:

```typescript
import { renderMarkdown } from '@/utils/markdown';
```

- [ ] **Step 8: Replace textarea section with conditional preview/edit**

Find the content block starting with `{noteType === 'text' ? (` (around line 1662) and replace the textarea with:

```tsx
{noteType === 'text' ? (
  <>
    {isEditingContent ? (
      <textarea
        ref={contentRef}
        autoCapitalize="sentences"
        placeholder={t('note.contentPlaceholder')}
        rows={4}
        className="w-full p-2 bg-transparent border-none outline-none resize-none placeholder-gray-500 dark:placeholder-gray-400 text-gray-900 dark:text-white min-h-[6rem]"
        value={content}
        onKeyDown={(e) => {
          if (e.nativeEvent?.isComposing || e.nativeEvent?.keyCode === 229) return;
          if (e.key === 'Escape') {
            e.preventDefault();
            setIsEditingContent(false);
          }
        }}
        onChange={(e) => {
          const newContent = e.target.value;
          const validationError = validateContent(newContent, t);
          if (validationError) {
            showError(validationError);
            return;
          }
          setContent(newContent);
          if (note) {
            markDirty();
            if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = setTimeout(async () => {
              saveTimeoutRef.current = undefined;
              await autoSaveNote(itemsRef.current);
            }, VALIDATION.AUTO_SAVE_TIMEOUT_MS);
          }
        }}
      />
    ) : (
      <div
        data-testid="note-content-preview"
        role="textbox"
        aria-label={t('note.contentPlaceholder')}
        aria-multiline="true"
        tabIndex={0}
        onClick={() => setIsEditingContent(true)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsEditingContent(true); } }}
        className="w-full p-2 min-h-[6rem] cursor-text text-gray-900 dark:text-white markdown-content"
        dangerouslySetInnerHTML={{
          __html: renderMarkdown(content) ||
            `<span class="text-gray-400 dark:text-gray-500 pointer-events-none">${t('note.contentPlaceholder')}</span>`,
        }}
      />
    )}
    {isEditingContent && (
      <div className="flex items-center gap-1 pt-1 border-t border-gray-100 dark:border-slate-700">
        <button
          type="button"
          aria-label={t('note.formatBold')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => wrapContentSelection('**', '**')}
          className="px-2 py-1 text-sm font-bold text-gray-600 dark:text-gray-300 rounded hover:bg-gray-100 dark:hover:bg-slate-700"
        >
          B
        </button>
        <button
          type="button"
          aria-label={t('note.formatItalic')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => wrapContentSelection('*', '*')}
          className="px-2 py-1 text-sm italic text-gray-600 dark:text-gray-300 rounded hover:bg-gray-100 dark:hover:bg-slate-700"
        >
          I
        </button>
        <div className="w-px h-4 bg-gray-200 dark:bg-slate-600 mx-1" />
        <button
          type="button"
          aria-label={t('note.formatHeading')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={insertContentHeading}
          className="px-2 py-1 text-sm text-gray-600 dark:text-gray-300 rounded hover:bg-gray-100 dark:hover:bg-slate-700"
        >
          H₁
        </button>
        <button
          type="button"
          aria-label={t('note.formatBulletList')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={insertContentBullet}
          className="px-2 py-1 text-sm text-gray-600 dark:text-gray-300 rounded hover:bg-gray-100 dark:hover:bg-slate-700"
        >
          • list
        </button>
      </div>
    )}
  </>
) : (
  // existing todo items JSX — unchanged
```

- [ ] **Step 9: Intercept Dialog onClose for two-step dismiss**

Find the `<Dialog>` tag (around line 1471):

```tsx
// BEFORE:
<Dialog open={true} onClose={handleCloseRequest} className="relative z-50">
```

Replace with:

```tsx
// AFTER:
<Dialog
  open={true}
  onClose={() => {
    if (isEditingContent) {
      setIsEditingContent(false);
    } else {
      handleCloseRequest();
    }
  }}
  className="relative z-50"
>
```

- [ ] **Step 10: Fix Enter-in-title to enter edit mode**

Find the `onKeyDown` handler on the title input (it focuses the content textarea on Enter, around line 1634). Update the `noteType === 'text'` branch:

```typescript
// BEFORE:
if (e.key === 'Enter') {
  e.preventDefault();
  if (noteType === 'text') {
    const textarea = contentRef.current;
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
  }
```

```typescript
// AFTER:
if (e.key === 'Enter') {
  e.preventDefault();
  if (noteType === 'text') {
    setIsEditingContent(true);
    // Focus happens via useEffect after state update
    requestAnimationFrame(() => {
      const textarea = contentRef.current;
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
    });
  }
```

- [ ] **Step 11: Run tests to verify they pass**

```bash
cd webapp && npx vitest run src/components/__tests__/NoteModal.test.tsx
```

Expected: all tests PASS.

- [ ] **Step 12: Run full test suite**

```bash
task test-webapp
```

Expected: all tests PASS.

- [ ] **Step 13: Commit**

```bash
git add webapp/src/components/NoteModal.tsx webapp/src/components/__tests__/NoteModal.test.tsx
git commit -m "feat: add render-on-blur markdown editing and formatting toolbar to NoteModal"
```

---

## Task 5: E2E test for markdown in webapp

**Files:**
- Create: `webapp/e2e/tests/markdown.spec.ts`

- [ ] **Step 1: Write the E2E test**

Create `webapp/e2e/tests/markdown.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';
import { authenticatedUserFixture } from '../fixtures';

test.describe('Markdown in text notes', () => {
  test.beforeEach(async ({ page }) => {
    await authenticatedUserFixture(page);
  });

  test('markdown renders in note card after saving', async ({ page }) => {
    // Create a new text note with markdown content
    await page.getByRole('button', { name: /new note/i }).click();
    await page.getByPlaceholder(/title/i).fill('Markdown test');
    // Click content area to enter edit mode
    await page.getByTestId('note-content-preview').click();
    await page.getByRole('textbox', { name: /content/i }).fill('**bold text**');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /close/i }).click();

    // Card should render markdown
    const card = page.getByTestId('note-card').filter({ hasText: 'Markdown test' });
    await expect(card.locator('strong')).toHaveText('bold text');
  });

  test('preview renders markdown, click enters edit mode', async ({ page }) => {
    await page.getByRole('button', { name: /new note/i }).click();
    await page.getByPlaceholder(/title/i).fill('Edit test');
    await page.getByTestId('note-content-preview').click();
    await page.getByRole('textbox', { name: /content/i }).fill('## Heading');
    await page.keyboard.press('Escape');

    // Preview should show rendered heading
    await expect(page.locator('[data-testid="note-content-preview"] h2')).toBeVisible();

    // Click preview to go back to edit
    await page.getByTestId('note-content-preview').click();
    await expect(page.getByRole('textbox', { name: /content/i })).toBeVisible();
  });

  test('backdrop click while editing collapses to preview, second click closes modal', async ({ page }) => {
    await page.getByRole('button', { name: /new note/i }).click();
    await page.getByPlaceholder(/title/i).fill('Dismiss test');
    await page.getByTestId('note-content-preview').click();
    const textarea = page.getByRole('textbox', { name: /content/i });
    await textarea.fill('some content');

    // Click backdrop — should collapse to preview, not close
    await page.mouse.click(10, 10);
    await expect(page.getByTestId('note-content-preview')).toBeVisible();

    // Click backdrop again — should close
    await page.mouse.click(10, 10);
    await expect(page.getByTestId('note-content-preview')).not.toBeVisible();
  });
});
```

Adapt `authenticatedUserFixture` to match the existing pattern in `webapp/e2e/fixtures/index.ts`.

- [ ] **Step 2: Run E2E tests**

```bash
task test-e2e
```

Expected: new markdown tests PASS, existing tests unaffected.

- [ ] **Step 3: Commit**

```bash
git add webapp/e2e/tests/markdown.spec.ts
git commit -m "test: add E2E tests for markdown note editing"
```

---

## Task 6: Install react-native-markdown-display (mobile)

**Files:**
- Modify: `mobile/package.json`

- [ ] **Step 1: Install the package**

```bash
cd mobile && npm install react-native-markdown-display
```

Expected: package added, no errors.

- [ ] **Step 2: Commit**

```bash
git add mobile/package.json mobile/package-lock.json
git commit -m "chore: install react-native-markdown-display"
```

---

## Task 7: Add i18n keys for formatting toolbar (mobile)

**Files:**
- Modify: `mobile/src/i18n/locales/en.json` + 7 other locale files

- [ ] **Step 1: Add keys to all locale files**

In each of the 8 locale files under `mobile/src/i18n/locales/`, add the same keys as the webapp (Task 3, Step 1–2). The key names and translations are identical.

`en.json`: `"formatBold": "Bold"`, `"formatItalic": "Italic"`, `"formatHeading": "Heading"`, `"formatBulletList": "Bullet list"`

Apply the same translations from Task 3 Step 2 for all 7 other locales.

- [ ] **Step 2: Commit**

```bash
git add mobile/src/i18n/locales/
git commit -m "feat: add i18n keys for markdown formatting toolbar (mobile)"
```

---

## Task 8: Add markdown editing to NoteEditorScreen (mobile)

**Files:**
- Modify: `mobile/src/screens/NoteEditorScreen.tsx`

This file is large (~400+ lines). Read through all steps before starting.

- [ ] **Step 1: Add import for Markdown renderer and Keyboard**

At the top of `NoteEditorScreen.tsx`, add:

```typescript
import Markdown from 'react-native-markdown-display';
import { Keyboard, InputAccessoryView, Platform } from 'react-native';
// InputAccessoryView is already in the react-native import — add it there
```

Update the existing `react-native` import to include `InputAccessoryView`:

```typescript
import {
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  Alert,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  InputAccessoryView,
  Keyboard,
  type TextInputProps,
  type TextInput as TextInputType,
} from 'react-native';
```

- [ ] **Step 2: Add isEditingContent state**

Find the state declarations (around line 87) and add:

```typescript
const [isEditingContent, setIsEditingContent] = useState(false);
```

Also add a constant for the iOS input accessory ID, near the top of the component:

```typescript
const MARKDOWN_TOOLBAR_ID = 'markdown-formatting-toolbar';
```

- [ ] **Step 3: Add keyboard hide listener to collapse to preview**

Find the section with `useEffect` hooks and add:

```typescript
useEffect(() => {
  const sub = Keyboard.addListener('keyboardDidHide', () => {
    setIsEditingContent(false);
  });
  return () => sub.remove();
}, []);
```

- [ ] **Step 4: Add formatting toolbar helper functions**

Before the `return` statement, add:

```typescript
const contentInputRef = useRef<TextInputType>(null);

const wrapMobileSelection = useCallback((before: string, after: string) => {
  // React Native TextInput doesn't expose selection API for programmatic wrapping,
  // so we append formatting syntax at the current cursor or wrap selection.
  // Simplest reliable approach: append to content with syntax inserted.
  setContent((prev) => prev + before + after);
  // Focus back so cursor lands inside the wrapping
  contentInputRef.current?.focus();
}, []);

const insertMobileBullet = useCallback(() => {
  setContent((prev) => {
    const insert = (prev.endsWith('\n') || prev === '') ? '- ' : '\n- ';
    return prev + insert;
  });
  contentInputRef.current?.focus();
}, []);

const insertMobileHeading = useCallback(() => {
  setContent((prev) => {
    const lines = prev.split('\n');
    const lastLine = lines[lines.length - 1];
    if (lastLine.startsWith('## ')) return prev;
    return prev + (prev.endsWith('\n') || prev === '' ? '' : '\n') + '## ';
  });
  contentInputRef.current?.focus();
}, []);
```

Note: React Native's TextInput does not support `setSelectionRange` in the same way as DOM inputs. These helpers append at the end. A future iteration can add proper cursor-aware insertion using `TextInput`'s `selection` prop.

- [ ] **Step 5: Replace the text content TextInput with conditional preview/edit**

Find where the text content `TextInput` is rendered for text notes. It will be inside a `noteType === 'text'` branch. Replace the content input with:

```tsx
{noteType === 'text' ? (
  <>
    {isEditingContent ? (
      <TextInput
        ref={contentInputRef}
        inputAccessoryViewID={Platform.OS === 'ios' ? MARKDOWN_TOOLBAR_ID : undefined}
        multiline
        autoCapitalize="sentences"
        placeholder={t('note.contentPlaceholder')}
        placeholderTextColor={colors.textSecondary}
        style={[styles.contentInput, { color: colors.text }]}
        value={content}
        onChangeText={(text) => {
          if (text.length > VALIDATION.CONTENT_MAX_LENGTH) {
            showToast(t('note.contentTooLong', { max: VALIDATION.CONTENT_MAX_LENGTH }), 'error');
            return;
          }
          setContent(text);
          markDirtyAndScheduleUpdate();
        }}
        testID="content-input"
      />
    ) : (
      <TouchableOpacity
        onPress={() => setIsEditingContent(true)}
        activeOpacity={1}
        testID="content-preview"
        style={styles.contentPreview}
      >
        {content ? (
          <Markdown style={{ body: { color: colors.text, fontSize: 14, lineHeight: 22 } }}>
            {content}
          </Markdown>
        ) : (
          <Text style={{ color: colors.textSecondary, fontSize: 14 }}>
            {t('note.contentPlaceholder')}
          </Text>
        )}
      </TouchableOpacity>
    )}

    {/* Android: formatting toolbar in layout (shown when editing) */}
    {Platform.OS === 'android' && isEditingContent && (
      <View style={[styles.formattingToolbar, { backgroundColor: colors.surfaceSecondary, borderTopColor: colors.border }]}>
        <TouchableOpacity onPress={() => wrapMobileSelection('**', '**')} style={styles.fmtBtn} accessibilityLabel={t('note.formatBold')}>
          <Text style={[styles.fmtBtnText, { color: colors.text, fontWeight: '700' }]}>B</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => wrapMobileSelection('*', '*')} style={styles.fmtBtn} accessibilityLabel={t('note.formatItalic')}>
          <Text style={[styles.fmtBtnText, { color: colors.text, fontStyle: 'italic' }]}>I</Text>
        </TouchableOpacity>
        <View style={styles.fmtSep} />
        <TouchableOpacity onPress={insertMobileHeading} style={styles.fmtBtn} accessibilityLabel={t('note.formatHeading')}>
          <Text style={[styles.fmtBtnText, { color: colors.text }]}>H₁</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={insertMobileBullet} style={styles.fmtBtn} accessibilityLabel={t('note.formatBulletList')}>
          <Text style={[styles.fmtBtnText, { color: colors.text }]}>• list</Text>
        </TouchableOpacity>
      </View>
    )}

    {/* iOS: formatting toolbar as inputAccessoryView (docks above keyboard) */}
    {Platform.OS === 'ios' && (
      <InputAccessoryView nativeID={MARKDOWN_TOOLBAR_ID}>
        <View style={[styles.formattingToolbar, { backgroundColor: colors.surfaceSecondary, borderTopColor: colors.border }]}>
          <TouchableOpacity onPress={() => wrapMobileSelection('**', '**')} style={styles.fmtBtn} accessibilityLabel={t('note.formatBold')}>
            <Text style={[styles.fmtBtnText, { color: colors.text, fontWeight: '700' }]}>B</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => wrapMobileSelection('*', '*')} style={styles.fmtBtn} accessibilityLabel={t('note.formatItalic')}>
            <Text style={[styles.fmtBtnText, { color: colors.text, fontStyle: 'italic' }]}>I</Text>
          </TouchableOpacity>
          <View style={styles.fmtSep} />
          <TouchableOpacity onPress={insertMobileHeading} style={styles.fmtBtn} accessibilityLabel={t('note.formatHeading')}>
            <Text style={[styles.fmtBtnText, { color: colors.text }]}>H₁</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={insertMobileBullet} style={styles.fmtBtn} accessibilityLabel={t('note.formatBulletList')}>
            <Text style={[styles.fmtBtnText, { color: colors.text }]}>• list</Text>
          </TouchableOpacity>
        </View>
      </InputAccessoryView>
    )}
  </>
) : (
  // existing todo items — unchanged
```

- [ ] **Step 6: Replace type toggle with Done button when editing**

Find the header right section (around line 877):

```tsx
// BEFORE:
<View style={styles.headerRight}>
  {!hasCreated && (
    <TouchableOpacity onPress={handleToggleNoteType} ...>
      ...
    </TouchableOpacity>
  )}
</View>
```

```tsx
// AFTER:
<View style={styles.headerRight}>
  {isEditingContent ? (
    <TouchableOpacity
      onPress={() => { Keyboard.dismiss(); setIsEditingContent(false); }}
      style={[styles.typeToggle, { backgroundColor: colors.primaryLight }]}
      testID="done-editing-btn"
    >
      <Text style={[styles.typeToggleText, { color: colors.primary }]}>
        {t('common.done')}
      </Text>
    </TouchableOpacity>
  ) : (
    !hasCreated && (
      <TouchableOpacity onPress={handleToggleNoteType} style={[styles.typeToggle, { backgroundColor: colors.primaryLight }]} testID="toggle-note-type">
        <Ionicons
          name={noteType === 'text' ? 'list' : 'document-text-outline'}
          size={22}
          color={colors.primary}
        />
        <Text style={[styles.typeToggleText, { color: colors.primary }]}>
          {noteType === 'text' ? t('note.typeTodo') : t('note.typeText')}
        </Text>
      </TouchableOpacity>
    )
  )}
</View>
```

- [ ] **Step 7: Add i18n key for "Done"**

Check if `common.done` already exists in `mobile/src/i18n/locales/en.json`. If not, add it to all 8 locale files:

```json
"done": "Done"
```

Translations: `de: "Fertig"`, `es: "Listo"`, `fr: "Terminé"`, `it: "Fatto"`, `nl: "Klaar"`, `pl: "Gotowe"`, `pt: "Concluído"`

- [ ] **Step 8: Add new styles**

In the `StyleSheet.create({...})` at the bottom of `NoteEditorScreen.tsx`, add:

```typescript
contentPreview: {
  flex: 1,
  paddingHorizontal: 16,
  paddingTop: 8,
  minHeight: 120,
},
formattingToolbar: {
  flexDirection: 'row',
  alignItems: 'center',
  paddingHorizontal: 8,
  paddingVertical: 6,
  borderTopWidth: StyleSheet.hairlineWidth,
},
fmtBtn: {
  paddingHorizontal: 10,
  paddingVertical: 6,
  borderRadius: 6,
},
fmtBtnText: {
  fontSize: 14,
},
fmtSep: {
  width: StyleSheet.hairlineWidth,
  height: 18,
  backgroundColor: '#d1d5db',
  marginHorizontal: 4,
},
```

- [ ] **Step 9: Run mobile tests**

```bash
task test-mobile
```

Expected: all tests PASS.

- [ ] **Step 10: Run mobile linter**

```bash
task lint-mobile
```

Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add mobile/src/screens/NoteEditorScreen.tsx mobile/src/i18n/locales/
git commit -m "feat: add markdown render-on-blur editing to mobile NoteEditorScreen"
```

---

## Task 9: Final verification

- [ ] **Step 1: Run all tests**

```bash
task test
```

Expected: all tests PASS across server, webapp, mobile, and shared.

- [ ] **Step 2: Run all linters**

```bash
task lint
```

Expected: no errors.

- [ ] **Step 3: Run E2E tests**

```bash
task test-e2e
```

Expected: all tests PASS including the new markdown tests.

- [ ] **Step 4: Check translations**

```bash
task check-translations
```

Expected: no missing keys.
