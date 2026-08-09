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

/** Parses item text into renderable nodes. */
export function inlineMarkdownNodes(text: string): InlineNode[] {
  return normalizeInlineTokens(Lexer.lexInline(text, INLINE_LEXER_OPTIONS));
}

/**
 * The words of an item with the formatting dropped, for an accessibility label.
 *
 * A control's accessible name should identify the item the way the user knows it;
 * spelling out `**` and backticks is never useful there. This also keeps the
 * checkbox's name correct once #867 renders the editable row too.
 */
export function inlineMarkdownToText(text: string): string {
  if (!text.trim()) return text;
  return flattenInlineNodes(inlineMarkdownNodes(text));
}
