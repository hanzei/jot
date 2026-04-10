# Markdown Support for Text Notes

**Date:** 2026-04-09  
**Updated:** 2026-04-10  
**Status:** Implemented (webapp) — Mobile deferred

## Overview

Add markdown rendering to text notes. The content field stays plain text (no schema change); markdown is stored as-is and rendered at display time. The UX uses a render-on-blur pattern: the note shows formatted markdown by default and switches to a raw textarea when the user clicks in.

## Scope

- Webapp: note modal editor + note card preview ✅
- Mobile (React Native): deferred to follow-up
- Shared: markdown renderer utility (`webapp/src/utils/markdown.ts`) ✅

Out of scope: todo/list note items, rich-text WYSIWYG, markdown in titles.

## Webapp

### Note Modal — Editor

The text content area switches between two states.

**Preview state (default for existing notes)**
- Content rendered as HTML via `renderMarkdown()`
- Clicking anywhere in the content area enters edit mode
- The backdrop has a neutral dark overlay

**Edit state**
- A plain `<textarea>` with a subtle grey background (`bg-gray-50 dark:bg-slate-700/40`) replaces the rendered view
- The textarea auto-resizes to its full content height — no max-height cap; the modal's own scroll container handles overflow
- The backdrop shifts to a deep blue-tinted overlay (`bg-blue-950/50`) to visually signal editing
- A **Done** button appears below the textarea (right-aligned, blue text) to exit edit mode
- Clicking "Done" or pressing Escape collapses back to preview

**Collapsing to preview**
- Pressing Escape
- Clicking the "Done" button
- Clicking the modal backdrop (first click — see dismiss flow below)

**Two-step modal dismiss**
- While in edit state: backdrop click or Escape collapses to preview, modal stays open
- While in preview state: backdrop click or Escape closes the modal
- The `×` close button always closes immediately regardless of state
- Implementation: HeadlessUI's `onClose` handles Escape; a `backdropHandledRef` flag prevents double-firing when clicking the backdrop

**No formatting toolbar** — removed after initial implementation; users write markdown syntax directly.

**New note behaviour**: new text notes open directly in edit mode (textarea visible, no preview step).

### Note Card — Dashboard Preview

- Text note content rendered as markdown via `renderMarkdown()`, line-clamped to 6 lines
- Links, bold, italic, headings, and lists render visually in the card

### Markdown Feature Set

| Syntax | Output |
|--------|--------|
| `# Heading` | `<h1>` |
| `## Heading` | `<h2>` |
| `### Heading` | `<h3>` |
| `**bold**` | `<strong>` |
| `*italic*` | `<em>` |
| `- item` | `<ul><li>` |
| `1. item` | `<ol><li>` |
| `> quote` | `<blockquote>` |
| `` `code` `` | `<code>` |
| `[text](url)` | `<a target="_blank" rel="noopener noreferrer">` |

Not supported in this iteration: tables, fenced code blocks, images.

### Markdown Renderer (`webapp/src/utils/markdown.ts`)

Uses `marked` (v18+) for parsing and `DOMPurify` for XSS sanitization:
- `marked.parse(content, { async: false })` — synchronous, GFM enabled, `breaks: true`
- Custom link renderer adds `target="_blank" rel="noopener noreferrer"` and `encodeURI` on href
- DOMPurify allowlist: `h1, h2, h3, p, br, strong, em, ul, ol, li, blockquote, code, a`
- `@types/dompurify` not needed — DOMPurify v3 ships its own declarations
- Returns `''` for blank/whitespace-only input
- Fallback: if `renderMarkdown` returns empty for non-empty content (e.g. plain text with HTML-special chars stripped), HTML-escapes the raw content so it is never silently hidden

### CSS (`webapp/src/index.css`)

`.markdown-content` component class provides heading, list, blockquote, code, and link styles that restore browser defaults removed by Tailwind's preflight reset. Applied to both the note card preview div and the modal preview div.

### Internationalisation

i18n keys added to all 8 locale files (`en`, `de`, `es`, `fr`, `it`, `nl`, `pl`, `pt`):
- `note.formatBold`, `note.formatItalic`, `note.formatHeading`, `note.formatBulletList` — reserved for future toolbar re-introduction
- `common.done` — used by the Done button in the modal

## Mobile (React Native)

Deferred. Design: Done button in header replacing the type toggle while editing, formatting toolbar via `InputAccessoryView` (iOS) / layout (Android), `react-native-markdown-display` for rendering. See mobile states mockup in `docs/superpowers/`.

## Storage

No schema changes. The `content` field on the `Note` model remains a plain `string`. Markdown syntax is stored verbatim and rendered at read time. Existing plain-text notes render correctly (plain text is valid markdown).

## Non-goals

- No migration of existing note content
- No server-side rendering or markdown-to-HTML storage
- No WYSIWYG / contenteditable editor
- No markdown support in note titles or todo/list item text
