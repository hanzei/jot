import { Lexer } from 'marked';
import {
  normalizeInlineTokens,
  flattenInlineNodes,
  INLINE_LEXER_OPTIONS,
  type InlineNode,
} from '@jot/shared';

// The mobile entry points to the inline Markdown subset used for list-item text.
// The subset itself, and why it is inline-only, live in shared/src/inlineMarkdown.ts
// and docs/specs/markdown-rendering.md §2.1. Keeping the lexing here rather than in
// the component means there is one place on this client that decides how item text
// is parsed, matching webapp/src/utils/markdown.ts.

/**
 * Parses item text into renderable nodes.
 *
 * Always with source tracking on (the `0`), like the webapp's `renderInlineItem`:
 * the editable row maps a tap back to an offset in the source through the spans
 * it records (`src/utils/inlineCaret.ts`), and a renderer that ignores them pays
 * nothing for their being there.
 */
export function inlineMarkdownNodes(text: string): InlineNode[] {
  return normalizeInlineTokens(Lexer.lexInline(text, INLINE_LEXER_OPTIONS), 0);
}

/**
 * The words of an item with the formatting dropped, for an accessibility label.
 *
 * A control's accessible name should identify the item the way the user knows it;
 * spelling out `**` and backticks is never useful there — and every row renders
 * its Markdown now, editable or not, so the source is not what is on screen
 * either.
 */
export function inlineMarkdownToText(text: string): string {
  if (!text.trim()) return text;
  return flattenInlineNodes(inlineMarkdownNodes(text));
}
