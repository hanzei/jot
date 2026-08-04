import { marked, Lexer, Tokens } from 'marked';
import DOMPurify from 'dompurify';
import {
  formatLiteralImage,
  isAllowedLinkHref,
  normalizeInlineTokens,
  flattenInlineNodes,
  INLINE_LEXER_OPTIONS,
  type InlineNode,
} from '@jot/shared';

// Jot's Markdown feature set is specified in docs/specs/markdown-rendering.md
// and is shared with the mobile app, which reaches it through markdown-it.
// Anything changed here needs a matching change in mobile/src/utils/markdown.ts.

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Normalizes a link target for an `href` attribute, or returns null if Jot will
 * not link it.
 *
 * The encode/decode dance is marked's own `cleanUrl`: encode, then undo the
 * '%' → '%25' double-encoding so an already-encoded URL (e.g. .../Caf%C3%A9)
 * round-trips unchanged instead of ending up broken. It also encodes the quote
 * that would otherwise close the attribute early; DOMPurify is the net behind
 * that, not the first line of defence.
 */
function safeLinkHref(href: string): string | null {
  // Narrower than DOMPurify's own filtering, which would allow tel: and app
  // deep links through.
  if (!isAllowedLinkHref(href)) return null;
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

marked.use({
  // Mobile lexes with the same two options (BLOCK_LEXER_OPTIONS in
  // mobile/src/utils/markdown.ts). Registered globally here because the webapp's
  // renderer overrides below are global too; mobile passes them per call.
  breaks: true,
  gfm: true,
  renderer: {
    link({ href, tokens }: Tokens.Link): string {
      const text = this.parser.parseInline(tokens);
      const safeHref = safeLinkHref(href);
      if (safeHref === null) return text;
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },

    // marked has no image *tokenizer* to disable — v18 handles images inside
    // the link tokenizer, and use({ tokenizer: { image: () => false } }) both
    // throws ("tokenizer 'image' does not exist") and, for tokenizers that do
    // exist, means "fall through to the default". Renderer override it is.
    image({ text, href, title }: Tokens.Image): string {
      return escapeHtml(formatLiteralImage(text, href, title));
    },

    // Same reason as image(): disabling the table tokenizer falls through to
    // the default and still renders a full <table>.
    table(token: Tokens.Table): string {
      return `<p>${escapeHtml(token.raw.trim()).replace(/\n/g, '<br>')}</p>\n`;
    },

    // marked v18 has a first-class checkbox token, so the rendered checkbox
    // needs no <input> in the allowlist and is inert by construction.
    checkbox({ checked }: Tokens.Checkbox): string {
      return checked ? '☑ ' : '☐ ';
    },

    // Raw HTML is never rendered; it shows its own source, like images and
    // tables. Escaping it here rather than leaving it to the DOMPurify
    // allowlist (which would strip the tag and keep the words) is what matches
    // mobile, where markdown-it runs with html: false and the tags survive as
    // literal text. DOMPurify still runs afterwards as the safety net.
    html(token: Tokens.HTML | Tokens.Tag): string {
      const escaped = escapeHtml(token.raw);
      if (!token.block) return escaped;
      return `<p>${escaped.trim().replace(/\n/g, '<br>')}</p>\n`;
    },
  },
});

// The effective spec for raw HTML: anything parsed but not listed here has its
// tag stripped and its text kept.
const ALLOWED_TAGS = [
  // h4-h6 stay real heading elements and are styled as bold body text
  // (.markdown-content in index.css), which is also how mobile renders them.
  'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'del',
  'ul', 'ol', 'li',
  'blockquote', 'code', 'pre', 'hr',
  'a',
];
const ALLOWED_ATTR = ['href', 'target', 'rel'];

export function renderMarkdown(content: string): string {
  if (!content.trim()) return '';
  const raw = marked.parse(content, { async: false });
  return DOMPurify.sanitize(raw, { ALLOWED_TAGS, ALLOWED_ATTR });
}

// List-item text renders an inline-only subset — see shared/src/inlineMarkdown.ts
// for what it is and why, and docs/specs/markdown-rendering.md §2.1 for the spec.
// The allowlist is narrower than ALLOWED_TAGS by construction: no block element
// can be produced, so none is permitted through.
const INLINE_ALLOWED_TAGS = ['strong', 'em', 'del', 'code', 'a', 'br'];

function renderInlineNodes(nodes: InlineNode[]): string {
  let html = '';

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        html += escapeHtml(node.value);
        break;
      case 'code':
        html += `<code>${escapeHtml(node.value)}</code>`;
        break;
      case 'br':
        html += '<br>';
        break;
      case 'strong':
        html += `<strong>${renderInlineNodes(node.children)}</strong>`;
        break;
      case 'em':
        html += `<em>${renderInlineNodes(node.children)}</em>`;
        break;
      case 'del':
        html += `<del>${renderInlineNodes(node.children)}</del>`;
        break;
      case 'link': {
        const label = renderInlineNodes(node.children);
        // normalizeInlineTokens has already dropped links Jot will not follow,
        // so this only guards the encodeURI failure path.
        const safeHref = safeLinkHref(node.href);
        html += safeHref === null
          ? label
          : `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        break;
      }
    }
  }

  return html;
}

/**
 * Renders one list-item's text as inline Markdown.
 *
 * Lexed as inline content rather than parsed as a document, which is what keeps
 * `# x`, `- [ ] x` and `---` literal without any suppression: an item is already
 * a list item, so block syntax inside one has nothing to describe.
 */
export function renderInlineMarkdown(text: string): string {
  if (!text.trim()) return '';
  const nodes = normalizeInlineTokens(Lexer.lexInline(text, INLINE_LEXER_OPTIONS));
  return DOMPurify.sanitize(renderInlineNodes(nodes), {
    ALLOWED_TAGS: INLINE_ALLOWED_TAGS,
    ALLOWED_ATTR,
  });
}

/**
 * The same item text as `renderInlineMarkdown` produces, with the formatting
 * dropped — for an `aria-label`, which must say what the eye sees rather than
 * spelling out the source markers.
 */
export function inlineMarkdownToText(text: string): string {
  if (!text.trim()) return text;
  return flattenInlineNodes(normalizeInlineTokens(Lexer.lexInline(text, INLINE_LEXER_OPTIONS)));
}
