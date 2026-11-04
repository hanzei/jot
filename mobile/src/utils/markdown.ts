import { Lexer } from 'marked';
import { normalizeBlockTokens, BLOCK_LEXER_OPTIONS, type BlockNode } from '@jot/shared';

// The mobile entry point to text-note content. The walk itself, and why it is
// shared, live in shared/src/blockMarkdown.ts; the renderers over it are
// components/Markdown.tsx (editor) and components/MarkdownPreview.tsx (cards).
//
// Keeping the lexing here rather than in the components means there is one place
// on this client that decides how note content is parsed, matching
// utils/inlineMarkdown.ts and webapp/src/utils/markdown.ts.

/**
 * Parses text-note content into renderable blocks.
 *
 * `locateTasks` additionally tags each task checkbox with its source offset, for
 * the one surface that makes them tappable (the editor's read mode,
 * docs/specs/markdown-rendering.md §2.4). Note cards leave it off.
 */
export function blockMarkdownNodes(content: string, locateTasks = false): BlockNode[] {
  const tokens = Lexer.lex(content, BLOCK_LEXER_OPTIONS);
  return normalizeBlockTokens(tokens, locateTasks ? { taskSource: content } : {});
}
