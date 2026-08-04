// The block half of Jot's Markdown, normalized once for both clients.
//
// Text-note content is parsed as a document; list-item text is lexed as inline
// content only (inlineMarkdown.ts). This module owns the first of those, and
// delegates every inline run to the second, so the policy decisions — which
// schemes may link, what an image degrades to, what happens to raw HTML — are
// made in exactly one place for both feature sets on both clients.
//
// Both clients lex with their own `marked` instance and normalize through here.
// Only the leaf rendering differs: an HTML string in the webapp, a tree of React
// Native components on mobile. The feature set itself is specified in
// docs/specs/markdown-rendering.md.

import {
  normalizeInlineTokens,
  type InlineMarkdownToken,
  type InlineNode,
} from './inlineMarkdown';

/**
 * The marked token fields this module reads, declared structurally rather than
 * imported from `marked` — for the module-resolution reason spelled out on
 * `InlineMarkdownToken`, which applies identically here.
 *
 * marked's `Token` union is structurally assignable to this, so callers pass
 * `Lexer.lex(...)` output directly with no cast. That is also why it extends the
 * inline token type: an inline run is handed straight to `normalizeInlineTokens`.
 */
export interface BlockMarkdownToken extends InlineMarkdownToken {
  tokens?: BlockMarkdownToken[];
  /** Heading level, 1-6. */
  depth?: number;
  /** Task-list marker state, on a `checkbox` token. */
  checked?: boolean;
  ordered?: boolean;
  /** First number of an ordered list; marked leaves it `''` when there is none. */
  start?: number | string;
  /** Whether list items hold block content — see the `loose` note on `BlockNode`. */
  loose?: boolean;
  items?: BlockMarkdownToken[];
}

/**
 * A block-level node. Deliberately smaller than marked's token union:
 * everything Jot does not render has already been degraded to a paragraph of
 * literal text by `normalizeBlockTokens`, so a renderer only has to handle these
 * six cases and cannot accidentally give an unsupported construct a rendering of
 * its own. Same rule as `InlineNode`.
 */
export type BlockNode =
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'heading'; depth: number; children: InlineNode[] }
  | { type: 'code'; text: string }
  | { type: 'blockquote'; children: BlockNode[] }
  | { type: 'list'; ordered: boolean; start: number; loose: boolean; items: BlockNode[][] }
  | { type: 'hr' };

/**
 * Lexer options both clients must pass when lexing text-note content.
 *
 * `breaks: true` makes a single newline a line break (docs/specs §2). Pinned
 * here rather than registered with `marked.use()`, which is global: the item
 * lexer runs from the same module instance with `INLINE_LEXER_OPTIONS`, and a
 * global would silently apply to both.
 */
export const BLOCK_LEXER_OPTIONS = { gfm: true, breaks: true };

/** The ☐ / ☑ a task-list marker renders as, with the space marked keeps. */
function checkboxText(token: BlockMarkdownToken): string {
  return token.checked ? '☑ ' : '☐ ';
}

/**
 * Converts an inline token run into nodes.
 *
 * `checkbox` is swapped for its text here rather than inside
 * `normalizeInlineTokens`, which only ever sees inline-lexed item text and so
 * can never encounter one: a checkbox token exists only inside a real task-list
 * item. A *loose* task list puts it inside the item's paragraph, at inline
 * position, which is why this sits on the inline path and not only on the block
 * one.
 */
function inlineNodes(tokens: BlockMarkdownToken[]): InlineNode[] {
  return normalizeInlineTokens(
    tokens.map((token) =>
      token.type === 'checkbox'
        ? { type: 'text', raw: token.raw, text: checkboxText(token) }
        : token,
    ),
  );
}

/**
 * A paragraph holding one run of literal, unparsed text.
 *
 * What every unsupported construct degrades to. Emitting a paragraph rather than
 * a node type of its own is the point: the text has already been decided, so
 * there is nothing left for a renderer to interpret — a URL inside a table cell
 * or an `href` attribute stays text, as docs/specs §3 requires.
 */
function literalParagraph(text: string): BlockNode {
  return { type: 'paragraph', children: [{ type: 'text', value: text }] };
}

/**
 * Converts marked block tokens into `BlockNode`s, degrading everything outside
 * the supported set to a paragraph of literal source.
 */
export function normalizeBlockTokens(tokens: BlockMarkdownToken[]): BlockNode[] {
  const nodes: BlockNode[] = [];

  // A tight list item's tokens are a bare run of `checkbox` / `text` rather than
  // a paragraph, and the checkbox has to end up on the same line as the text
  // that follows it. Buffering the run and flushing it as one paragraph is what
  // keeps them together.
  let run: BlockMarkdownToken[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    nodes.push({ type: 'paragraph', children: inlineNodes(run) });
    run = [];
  };

  for (const token of tokens) {
    if (token.type === 'text' || token.type === 'checkbox') {
      run.push(token);
      continue;
    }
    flushRun();

    switch (token.type) {
      // Blank lines between blocks, and link reference definitions, which marked
      // has already resolved into the links that use them. A `def` is the one
      // token neither rendered nor degraded to source: there is no source left
      // to show once the reference has been substituted.
      case 'space':
      case 'def':
        break;

      case 'paragraph':
        nodes.push({ type: 'paragraph', children: inlineNodes(token.tokens ?? []) });
        break;

      case 'heading':
        // h4-h6 keep their depth and are styled down to bold body text rather
        // than rewritten, so the document outline survives (docs/specs §5).
        nodes.push({
          type: 'heading',
          depth: token.depth ?? 1,
          children: inlineNodes(token.tokens ?? []),
        });
        break;

      case 'code':
        // The language tag is deliberately dropped — no syntax highlighting
        // (docs/specs §6).
        nodes.push({ type: 'code', text: token.text ?? '' });
        break;

      case 'blockquote':
        nodes.push({ type: 'blockquote', children: normalizeBlockTokens(token.tokens ?? []) });
        break;

      case 'list':
        nodes.push({
          type: 'list',
          ordered: token.ordered ?? false,
          // marked leaves `start` as '' for an unordered list and for `1.`.
          start: typeof token.start === 'number' ? token.start : 1,
          loose: token.loose ?? false,
          items: (token.items ?? []).map((item) => normalizeBlockTokens(item.tokens ?? [])),
        });
        break;

      case 'hr':
        nodes.push({ type: 'hr' });
        break;

      // Tables and raw HTML show their own source (docs/specs §3). `raw` is the
      // whole construct — a table's header row included — and using it discards
      // the parsed contents, which is what keeps a URL inside a cell or an
      // `href` attribute from becoming a live link.
      case 'table':
      case 'html':
        nodes.push(literalParagraph(token.raw.trim()));
        break;

      default:
        // Unreachable for the syntax Jot supports. Degrading to source keeps the
        // fallback consistent with every other one rather than dropping content.
        nodes.push(literalParagraph(token.raw));
        break;
    }
  }

  flushRun();
  return nodes;
}
