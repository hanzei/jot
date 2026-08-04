import { Lexer, type Token, type Tokens } from 'marked';
import { normalizeInlineTokens, type InlineNode } from '@jot/shared';

// Text-note content, lexed into a platform-neutral block tree.
//
// Jot's Markdown feature set is specified in docs/specs/markdown-rendering.md.
// Both clients now lex with `marked`: the webapp turns its tokens into HTML,
// mobile turns them into the nodes below and renders them as React Native
// components (Markdown.tsx for the editor, MarkdownPreview.tsx for note cards).
//
// The inline half is not repeated here — every inline run goes through
// `normalizeInlineTokens` in shared/src/inlineMarkdown.ts, the same normalizer
// list-item text uses, so the link-scheme policy and the image/HTML degradations
// are decided in exactly one place for both clients and both feature sets.

/**
 * A block-level node. Deliberately smaller than marked's token union:
 * everything Jot does not render has already been degraded to a paragraph of
 * literal text by `blockNodes`, so a renderer only has to handle these six cases
 * and cannot accidentally give an unsupported construct a rendering of its own.
 * Same rule as `InlineNode` in shared/src/inlineMarkdown.ts.
 */
export type BlockNode =
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'heading'; depth: number; children: InlineNode[] }
  | { type: 'code'; text: string }
  | { type: 'blockquote'; children: BlockNode[] }
  | { type: 'list'; ordered: boolean; start: number; items: BlockNode[][] }
  | { type: 'hr' };

/**
 * Lexer options for text-note content.
 *
 * `breaks: true` makes a single newline a line break (docs/specs §2) and matches
 * the webapp's `marked.use({ breaks: true })`. Passed explicitly rather than
 * registered globally with `marked.use()`: the item renderer lexes with its own
 * options (`INLINE_LEXER_OPTIONS`) from the same module instance, and a global
 * would apply to both.
 */
const BLOCK_LEXER_OPTIONS = { gfm: true, breaks: true };

/** The ☐ / ☑ a task-list marker renders as, with the space marked keeps. */
function checkboxText(token: Tokens.Checkbox): string {
  return token.checked ? '☑ ' : '☐ ';
}

/**
 * Converts an inline token run into nodes.
 *
 * `checkbox` is swapped for its text here rather than in the shared normalizer,
 * which only ever sees inline-lexed item text and so can never encounter one:
 * a checkbox token exists only inside a real task-list item. A *loose* task list
 * puts it inside the item's paragraph, which is why this sits on the inline path
 * and not only on the block one.
 */
function inlineNodes(tokens: Token[]): InlineNode[] {
  return normalizeInlineTokens(
    tokens.map((token) =>
      token.type === 'checkbox'
        ? { type: 'text', raw: token.raw, text: checkboxText(token as Tokens.Checkbox) }
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

// marked's token union ends in `Tokens.Generic`, which carries an index
// signature, so every other member is assignable to it and narrowing a `Token`
// by `type` cannot eliminate it: each case below comes out as
// `Tokens.X | Tokens.Generic`, where the fields that matter are `any`. Hence the
// cast in each case — the `type` check above it is what makes it sound. Jot
// registers no marked extension, so a Generic token never actually arrives.
function blockNodes(tokens: Token[]): BlockNode[] {
  const nodes: BlockNode[] = [];

  // A tight list item's tokens are a bare run of `checkbox` / `text` rather than
  // a paragraph, and the checkbox has to end up on the same line as the text
  // that follows it. Buffering the run and flushing it as one paragraph is what
  // keeps them together.
  let run: Token[] = [];
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
      // has already resolved into the links that use them.
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
          depth: (token as Tokens.Heading).depth,
          children: inlineNodes(token.tokens ?? []),
        });
        break;

      case 'code':
        // `lang` is deliberately ignored — no syntax highlighting (docs/specs §6).
        nodes.push({ type: 'code', text: (token as Tokens.Code).text });
        break;

      case 'blockquote':
        nodes.push({ type: 'blockquote', children: blockNodes(token.tokens ?? []) });
        break;

      case 'list': {
        const list = token as Tokens.List;
        nodes.push({
          type: 'list',
          ordered: list.ordered,
          // marked leaves `start` as '' for an unordered list and for `1.`.
          start: typeof list.start === 'number' ? list.start : 1,
          items: list.items.map((item) => blockNodes(item.tokens ?? [])),
        });
        break;
      }

      case 'hr':
        nodes.push({ type: 'hr' });
        break;

      // Tables and raw HTML show their own source (docs/specs §3). `raw` is the
      // whole construct — a table's header row included — which is the one thing
      // markdown-it made hard and marked gives away for free.
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

/** Parses text-note content into renderable blocks. */
export function blockMarkdownNodes(content: string): BlockNode[] {
  if (!content.trim()) return [];
  return blockNodes(Lexer.lex(content, BLOCK_LEXER_OPTIONS));
}
