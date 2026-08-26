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
 * the `@babel/runtime` note in CLAUDE.md describes.
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
 * Where a node's visible content came from in the source string, as a
 * half-open `[start, end)` range.
 *
 * Present only when `normalizeInlineTokens` is called with a source offset —
 * see that function. It spans the *content*, not the token: for `**milk**` the
 * strong node spans the whole thing but its child text node spans just `milk`,
 * which is what makes a rendered offset inside the child map back linearly.
 */
export interface InlineSourceSpan {
  start: number;
  end: number;
}

/**
 * A platform-neutral inline node. Deliberately smaller than marked's token
 * union: everything unsupported has already been degraded to `text` by
 * `normalizeInlineTokens`, so a renderer only has to handle these five cases and
 * cannot accidentally give an unsupported construct a rendering of its own.
 *
 * `src` is spelled out per member rather than intersected onto the union so
 * that narrowing on `type` keeps working exactly as it did.
 */
export type InlineNode =
  | { type: 'text'; value: string; src?: InlineSourceSpan }
  | { type: 'code'; value: string; src?: InlineSourceSpan }
  | { type: 'br'; src?: InlineSourceSpan }
  | { type: 'strong'; children: InlineNode[]; src?: InlineSourceSpan }
  | { type: 'em'; children: InlineNode[]; src?: InlineSourceSpan }
  | { type: 'del'; children: InlineNode[]; src?: InlineSourceSpan }
  | { type: 'link'; href: string; children: InlineNode[]; src?: InlineSourceSpan };

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

function textNode(value: string, src?: InlineSourceSpan): InlineNode {
  return src ? { type: 'text', value, src } : { type: 'text', value };
}

/**
 * Where a token's visible content starts inside its own `raw` — the length of
 * the opening delimiter, in effect: 2 for `**milk**`, 1 for `` `npm ci` `` and
 * for `[docs](url)`, 0 for plain text.
 *
 * Found by search rather than by knowing each construct's markers, because a
 * construct can be spelled several ways (`**x**` and `__x__` are both strong)
 * and marked does not report which was used. The first occurrence is the right
 * one for every construct in the subset, since an opening delimiter is never
 * itself part of the content it opens.
 *
 * Worst case — content that also appears inside the opening delimiter, as in
 * `*[*](x)*` — this lands a few characters out. That moves a caret, which the
 * user can see and correct; nothing downstream depends on it being exact.
 */
function contentOffset(raw: string, content: string): number {
  if (!content) return 0;
  const at = raw.indexOf(content);
  return at === -1 ? 0 : at;
}

/**
 * Flattens a node list back to its visible text. Used for a link whose target
 * Jot will not follow: the spec renders it as its label, and the label keeps any
 * formatting it had, matching how the webapp's block renderer treats the same
 * case.
 */
function normalizeLink(token: InlineMarkdownToken, span: InlineSourceSpan | undefined): InlineNode[] {
  const children = normalizeInlineTokens(token.tokens ?? [], childSourceStart(token, span));
  const href = token.href ?? '';

  if (!isAllowedLinkHref(href)) return children;

  // `[](https://example.com)` lexes to a link with no children at all. Rendered
  // faithfully that is an invisible tappable region, so the target becomes its
  // own label.
  const label = children.length > 0 ? children : [textNode(href, span)];
  return [span ? { type: 'link', href, children: label, src: span } : { type: 'link', href, children: label }];
}

/**
 * The source offset the children of a container token start at, or undefined
 * when source tracking is off. Children raws are contiguous inside the parent's
 * raw, so the whole run is located once and each child then advances the cursor
 * by its own length.
 */
function childSourceStart(
  token: InlineMarkdownToken,
  span: InlineSourceSpan | undefined,
): number | undefined {
  if (!span) return undefined;
  const inner = (token.tokens ?? []).map((child) => child.raw).join('');
  return span.start + contentOffset(token.raw, inner);
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

/** How many characters of visible text a node contributes. */
function renderedLength(node: InlineNode): number {
  switch (node.type) {
    case 'text':
    case 'code':
      return node.value.length;
    // Counted, because a line break occupies one position for a caret just as
    // the newline it came from does in the source.
    case 'br':
      return 1;
    default:
      return node.children.reduce((total, child) => total + renderedLength(child), 0);
  }
}

/**
 * Maps an offset in the *rendered* text back to an offset in the source.
 *
 * This is what lets a click on rendered item text open the editor with the
 * caret where the user pointed: they clicked character 4 of `buy milk`, and the
 * textarea behind it holds `buy **milk**`, where that character is at 6.
 *
 * Requires nodes produced with source tracking on (`normalizeInlineTokens(…, 0)`);
 * without it there is nothing to map to and the source length is returned, which
 * puts the caret at the end — the same place a swap with no mapping at all would.
 *
 * Exact for every construct whose visible text appears verbatim in its source,
 * which is all of them bar two: a reconstructed literal image and an escape
 * sequence render at a different length than they occupy, so an offset *inside*
 * one lands within the construct rather than exactly on the character. Both are
 * clamped to the construct, so the caret is never wildly wrong.
 */
export function inlineSourceOffset(
  nodes: InlineNode[],
  renderedOffset: number,
  sourceLength: number,
): number {
  let consumed = 0;
  // Where the last node that ended before `renderedOffset` finished, so a click
  // past the end of everything lands after the last construct rather than at 0.
  let lastEnd = 0;

  function walk(list: InlineNode[]): number | null {
    for (const node of list) {
      if (node.type === 'strong' || node.type === 'em' || node.type === 'del' || node.type === 'link') {
        const hit = walk(node.children);
        if (hit !== null) return hit;
      } else {
        const length = renderedLength(node);
        if (renderedOffset < consumed + length) {
          const within = renderedOffset - consumed;
          if (!node.src) return null;
          return Math.min(node.src.start + within, node.src.end);
        }
        consumed += length;
      }
      if (node.src) lastEnd = node.src.end;
    }
    return null;
  }

  return walk(nodes) ?? Math.min(lastEnd || sourceLength, sourceLength);
}

/**
 * Whether rendering `text` would show anything other than `text` itself.
 *
 * The webapp's editable row uses this to decide whether a row needs a rendered
 * view at all. `buy milk` renders to `buy milk`, so swapping it for a
 * non-editable copy of itself would be pure churn — an identical repaint, a
 * height that has to be re-measured, and a caret that has to be mapped, all to
 * arrive back where it started. Only a row whose author actually typed some
 * markup pays for any of that.
 *
 * Deliberately compares the text rather than testing for formatting nodes: a
 * node list can be all `text` and still differ from its source, because an
 * escape (`\*`) renders without its backslash.
 */
export function inlineRendersAsSource(nodes: InlineNode[], text: string): boolean {
  let rendered = '';

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        rendered += node.value;
        break;
      // A `br` is the one node whose rendering is not its source character for
      // character on every client, but it stands for exactly the newline that
      // produced it.
      case 'br':
        rendered += '\n';
        break;
      // Code renders in a different typeface, so it is a visible change even
      // when the characters match.
      default:
        return false;
    }
  }

  return rendered === text;
}

/**
 * Converts marked inline tokens into `InlineNode`s, degrading everything outside
 * the supported subset to literal text.
 *
 * Degradation is always to *source*, never to nothing — the same rule the full
 * renderer follows (docs/specs/markdown-rendering.md §3): unsupported syntax
 * that vanished would read as a bug rather than a limit.
 */
export function normalizeInlineTokens(
  tokens: InlineMarkdownToken[],
  sourceStart?: number,
): InlineNode[] {
  const nodes: InlineNode[] = [];
  const tracking = sourceStart !== undefined;
  let cursor = sourceStart ?? 0;

  for (const token of tokens) {
    // The token's own span, and the span of just its visible content. They
    // differ by the opening delimiter: `**milk**` against `milk`.
    const span = tracking ? { start: cursor, end: cursor + token.raw.length } : undefined;
    const contentSpan = (content: string): InlineSourceSpan | undefined =>
      span ? { start: span.start + contentOffset(token.raw, content), end: span.end } : undefined;
    if (span) cursor = span.end;

    switch (token.type) {
      case 'text':
      case 'escape': {
        // An inline `text` token is usually a leaf, but marked nests one level
        // in places (notably inside a link label), and a leaf's own `.text` is
        // the unescaped source — escaping is the renderer's job, not this one's.
        const nested = token.tokens;
        if (nested && nested.length > 0) {
          nodes.push(...normalizeInlineTokens(nested, childSourceStart(token, span)));
        } else {
          const value = token.text ?? '';
          nodes.push(textNode(value, contentSpan(value)));
        }
        break;
      }

      // Spelled out one per case: `token.type` is a plain string here, so a
      // shared arm would not narrow to the InlineNode literal union.
      case 'strong':
        nodes.push({
          type: 'strong',
          children: normalizeInlineTokens(token.tokens ?? [], childSourceStart(token, span)),
          ...(span && { src: span }),
        });
        break;

      case 'em':
        nodes.push({
          type: 'em',
          children: normalizeInlineTokens(token.tokens ?? [], childSourceStart(token, span)),
          ...(span && { src: span }),
        });
        break;

      case 'del':
        nodes.push({
          type: 'del',
          children: normalizeInlineTokens(token.tokens ?? [], childSourceStart(token, span)),
          ...(span && { src: span }),
        });
        break;

      case 'codespan': {
        const value = token.text ?? '';
        const src = contentSpan(value);
        nodes.push(src ? { type: 'code', value, src } : { type: 'code', value });
        break;
      }

      case 'link':
        nodes.push(...normalizeLink(token, span));
        break;

      case 'image':
        // Images are a gallery feature, never embedded (docs/specs/file-attachments.md).
        // Reconstructed rather than echoed, so the span covers the whole token
        // and an offset inside it is approximate — see `inlineSourceOffset`.
        nodes.push(textNode(formatLiteralImage(token.text ?? '', token.href ?? '', token.title), span));
        break;

      case 'html': {
        // Raw HTML shows its own source. Only the tags lex as `html`; the text
        // between them stays ordinary text, which is exactly what the webapp's
        // block renderer produces for inline HTML today.
        const value = token.text ?? '';
        nodes.push(textNode(value, contentSpan(value)));
        break;
      }

      case 'br':
        // Its own node rather than a "\n" text node: a literal newline collapses
        // to a space in HTML, so the webapp needs a real <br> while mobile wants
        // the newline. Neither can be derived from the other by the renderer.
        nodes.push({ type: 'br', ...(span && { src: span }) });
        break;

      default:
        // Block tokens cannot reach an inline lexer, so this is unreachable for
        // the syntax Jot supports. Emitting `raw` keeps the fallback consistent
        // with every other degradation rather than silently dropping content.
        nodes.push(textNode(token.raw, span));
        break;
    }
  }

  return nodes;
}
