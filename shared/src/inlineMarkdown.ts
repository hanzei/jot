// The inline Markdown subset used for list-note item text.
//
// Text-note content renders the full feature set in docs/specs/markdown-rendering.md.
// List items render a strictly inline subset of it, because an item *is* already a
// list item: it carries its own checkbox, nesting level and position, so every
// block construct either duplicates that structure or fights it.
//
// The subset is not enforced by suppressing block syntax — it falls out of lexing
// the item as inline content in the first place, so `# x`, `- [ ] x` and `---`
// arrive here as ordinary text tokens with nothing to strip. That is the whole
// reason this is cheaper than the block renderer, which has to parse those
// constructs and then collapse them back to their source.
//
// Both clients lex with their own `marked` instance and then normalize through
// this module, so the policy decisions — which schemes may link, what an image
// degrades to, what happens to raw HTML — are made in exactly one place. Only the
// leaf rendering differs: an HTML string in the webapp, a <Text> tree on mobile.

import { formatLiteralImage, isAllowedLinkHref } from './markdown';

/**
 * The marked token fields this module reads, declared structurally rather than
 * imported from `marked`.
 *
 * This is not a style preference. Both consumers compile `shared/src` with their
 * own tsc, and module resolution runs from `shared/` — `mobile/node_modules/@jot/shared`
 * is a symlink and resolution follows the realpath, so a lookup never reaches the
 * consumer's `node_modules`. CI installs dependencies in `webapp/` and `mobile/`
 * only, so `shared/node_modules` does not exist there and even a *type-only*
 * `import from 'marked'` fails to resolve for both consumers. It is the same trap
 * the `@babel/runtime` note in CLAUDE.md describes, and the same fix mobile's own
 * markdown.tsx uses for markdown-it.
 *
 * marked's `Token` union is structurally assignable to this, so callers pass
 * `Lexer.lexInline(...)` output directly with no cast.
 */
export interface InlineMarkdownToken {
  type: string;
  raw: string;
  text?: string;
  tokens?: InlineMarkdownToken[];
  href?: string;
  title?: string | null;
}

/**
 * A platform-neutral inline node. Deliberately smaller than marked's token
 * union: everything unsupported has already been degraded to `text` by
 * `normalizeInlineTokens`, so a renderer only has to handle these five cases and
 * cannot accidentally give an unsupported construct a rendering of its own.
 */
export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'br' }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'del'; children: InlineNode[] }
  | { type: 'link'; href: string; children: InlineNode[] };

/**
 * Lexer options both clients must pass when lexing item text.
 *
 * Pinned here, and passed per call, rather than registered with `marked.use()`,
 * which is global: item text and text-note content lex from the same module
 * instance with deliberately different entry points, and a global would apply
 * to both. `BLOCK_LEXER_OPTIONS` in blockMarkdown.ts is the other half of that.
 *
 * `breaks: true` matches text-note content, where a single newline is a line
 * break (docs/specs/markdown-rendering.md §2). It also makes newline handling
 * uniform — every newline arrives as a `br` token rather than sometimes hiding
 * inside a text token, which matters because the two clients break lines by
 * different means (`<br>` vs a literal "\n").
 */
export const INLINE_LEXER_OPTIONS = { gfm: true, breaks: true };

function textNode(value: string): InlineNode {
  return { type: 'text', value };
}

/**
 * Flattens a node list back to its visible text. Used for a link whose target
 * Jot will not follow: the spec renders it as its label, and the label keeps any
 * formatting it had, matching how the webapp's block renderer treats the same
 * case.
 */
function normalizeLink(token: InlineMarkdownToken): InlineNode[] {
  const children = normalizeInlineTokens(token.tokens ?? []);
  const href = token.href ?? '';

  if (!isAllowedLinkHref(href)) return children;

  // `[](https://example.com)` lexes to a link with no children at all. Rendered
  // faithfully that is an invisible tappable region, so the target becomes its
  // own label — the same instinct behind mobile refusing markdown-it's
  // empty-alt image links (docs/specs/markdown-rendering.md §5).
  const label = children.length > 0 ? children : [textNode(href)];
  return [{ type: 'link', href, children: label }];
}

/**
 * The visible text of a node tree, with all formatting dropped.
 *
 * For places that need the words without the markup — an `aria-label`, an
 * accessibility label, a title attribute. Rendering Markdown made these diverge
 * from what is on screen: a label built from the raw source announces
 * "star star Milk star star" for text the eye reads as bold Milk, and an
 * `aria-label` *replaces* the element's content for assistive technology, so the
 * markers become the only thing announced.
 */
export function flattenInlineNodes(nodes: InlineNode[]): string {
  let out = '';

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'code':
        out += node.value;
        break;
      // A label is a single line, so a break reads as a word gap.
      case 'br':
        out += ' ';
        break;
      default:
        out += flattenInlineNodes(node.children);
        break;
    }
  }

  return out;
}

/**
 * Converts marked inline tokens into `InlineNode`s, degrading everything outside
 * the supported subset to literal text.
 *
 * Degradation is always to *source*, never to nothing — the same rule the full
 * renderer follows (docs/specs/markdown-rendering.md §3): unsupported syntax
 * that vanished would read as a bug rather than a limit.
 */
export function normalizeInlineTokens(tokens: InlineMarkdownToken[]): InlineNode[] {
  const nodes: InlineNode[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'escape': {
        // An inline `text` token is usually a leaf, but marked nests one level
        // in places (notably inside a link label), and a leaf's own `.text` is
        // the unescaped source — escaping is the renderer's job, not this one's.
        const nested = token.tokens;
        if (nested && nested.length > 0) {
          nodes.push(...normalizeInlineTokens(nested));
        } else {
          nodes.push(textNode(token.text ?? ''));
        }
        break;
      }

      // Spelled out one per case: `token.type` is a plain string here, so a
      // shared arm would not narrow to the InlineNode literal union.
      case 'strong':
        nodes.push({ type: 'strong', children: normalizeInlineTokens(token.tokens ?? []) });
        break;

      case 'em':
        nodes.push({ type: 'em', children: normalizeInlineTokens(token.tokens ?? []) });
        break;

      case 'del':
        nodes.push({ type: 'del', children: normalizeInlineTokens(token.tokens ?? []) });
        break;

      case 'codespan':
        nodes.push({ type: 'code', value: token.text ?? '' });
        break;

      case 'link':
        nodes.push(...normalizeLink(token));
        break;

      case 'image':
        // Images are a gallery feature, never embedded (docs/specs/file-attachments.md).
        nodes.push(textNode(formatLiteralImage(token.text ?? '', token.href ?? '', token.title)));
        break;

      case 'html':
        // Raw HTML shows its own source. Only the tags lex as `html`; the text
        // between them stays ordinary text, which is exactly what the webapp's
        // block renderer produces for inline HTML today.
        nodes.push(textNode(token.text ?? ''));
        break;

      case 'br':
        // Its own node rather than a "\n" text node: a literal newline collapses
        // to a space in HTML, so the webapp needs a real <br> while mobile wants
        // the newline. Neither can be derived from the other by the renderer.
        nodes.push({ type: 'br' });
        break;

      default:
        // Block tokens cannot reach an inline lexer, so this is unreachable for
        // the syntax Jot supports. Emitting `raw` keeps the fallback consistent
        // with every other degradation rather than silently dropping content.
        nodes.push(textNode(token.raw));
        break;
    }
  }

  return nodes;
}
