# Markdown Support for Text Notes

**Date:** 2026-04-09  
**Status:** Approved

## Overview

Add markdown rendering to text notes. The content field stays plain text (no schema change); markdown is stored as-is and rendered at display time. The UX uses a seamless render-on-blur pattern: the note looks formatted when not being edited, and switches to raw markdown when the user clicks or taps in.

## Scope

- Webapp: note modal editor + note card preview
- Mobile (React Native): note editor screen
- Shared: a markdown renderer utility used by both webapp and mobile card previews

Out of scope: todo note items, rich-text WYSIWYG, markdown in titles.

## Webapp

### Note Modal — Editor

The text content area switches between two visual states with no border, background, or font change between them — the transition should feel invisible.

**Preview state (unfocused)**
- Content is rendered as HTML via a markdown renderer
- Clicking anywhere in the content area enters edit mode

**Edit state (focused)**
- A plain `<textarea>` replaces the rendered view; same font family, size (`14px`), and line-height (`1.6`) as the rendered view
- The textarea auto-resizes to content (existing behavior preserved)
- A formatting toolbar appears below the textarea, separated by a thin divider line:
  - **B** — wraps selection in `**...**`
  - *I* — wraps selection in `*...*`
  - **H₁** — prepends `## ` to the current line
  - **• list** — inserts `- ` at the start of the current line (or on a new line)
- Toolbar is hidden in preview state

**Collapsing to preview**
- Pressing Esc
- Clicking the modal backdrop while editing (first click — see dismiss flow below)
- Toolbar buttons use `mousedown` + `preventDefault` to retain textarea focus; blur is not used to trigger collapse

**Two-step modal dismiss**
- While in edit state: clicking the backdrop collapses to preview, modal stays open
- While in preview state: clicking the backdrop closes the modal (existing behavior)
- The `×` close button always closes immediately regardless of state

### Note Card — Dashboard Preview

- Text note content rendered as markdown (same renderer), existing `line-clamp-6` and `whitespace-pre-wrap` replaced with rendered HTML
- Links, bold, italic, headings, and lists render visually in the card

### Markdown Feature Set

Supported syntax (sufficient for notes use case, avoids complexity):

| Syntax | Output |
|--------|--------|
| `## Heading` | `<h2>` |
| `### Heading` | `<h3>` |
| `**bold**` | `<strong>` |
| `*italic*` | `<em>` |
| `- item` | `<ul><li>` |
| `> quote` | `<blockquote>` |
| `` `code` `` | `<code>` |
| `[text](url)` | `<a>` |

Not supported in this iteration: tables, fenced code blocks, nested lists beyond one level, images.

### Markdown Renderer

A small dedicated utility (e.g. `webapp/src/utils/markdown.ts`) wrapping a lightweight library such as [marked](https://marked.js.org/) or [micromark](https://github.com/micromark/micromark), configured to:
- Sanitize output (no raw HTML passthrough) to prevent XSS
- Produce only the supported subset above

The same renderer is used in the note modal and the note card.

## Mobile (React Native)

### Note Editor Screen

The same render-on-blur pattern, adapted to touch and keyboard lifecycle.

**Preview state**
- Content rendered as markdown using a React Native markdown renderer (e.g. `react-native-markdown-display`)
- Tapping the content area enters edit mode

**Edit state (keyboard open)**
- A `TextInput` (multiline) replaces the rendered view; same font and size
- **Done button** appears in the top-right header, replacing the note type toggle
  - Tapping Done: dismisses keyboard → collapses to preview
  - Type toggle reappears in preview state
- **Formatting toolbar** docks immediately above the keyboard:
  - iOS: implemented as `inputAccessoryView`
  - Android: positioned in the layout above the keyboard frame via `KeyboardAvoidingView`
  - Buttons: **B**, *I*, **H₁**, **• list** (same actions as webapp)
- The existing bottom toolbar (color, share, pin, archive, duplicate, labels, delete) remains visible in both states, pushed up by the keyboard in edit state

**Collapsing to preview**
- Tapping Done
- Keyboard dismissed via system gesture (swipe down / system back)
- Navigating back while in edit state saves content and collapses before exit

## Storage

No schema changes. The `content` field on the `Note` model remains a plain `string`. Markdown syntax is stored verbatim and rendered at read time. Existing plain-text notes render correctly (plain text is valid markdown).

## Internationalisation

Formatting toolbar buttons require i18n keys for accessibility labels (e.g. `note.formatBold`, `note.formatItalic`, `note.formatHeading`, `note.formatBulletList`). Add keys to all 8 locale files (`en`, `de`, `es`, `fr`, `it`, `nl`, `pl`, `pt`) and run `task check-translations` to verify.

## Non-goals

- No migration of existing note content
- No server-side rendering or markdown-to-HTML storage
- No WYSIWYG / contenteditable editor
- No markdown support in note titles or todo item text
