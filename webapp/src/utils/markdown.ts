import { marked, Tokens } from 'marked';
import DOMPurify from 'dompurify';
import { formatLiteralImage, isAllowedLinkHref } from '@jot/shared';

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

marked.use({
  // Mobile matches this via react-native-markdown-display's softbreak rule,
  // which emits a newline even though markdown-it runs with breaks: false.
  // Same output, different mechanism — "fixing" the mobile side to breaks: true
  // would look harmless and change nothing until that rule changes.
  breaks: true,
  gfm: true,
  renderer: {
    link({ href, tokens }: Tokens.Link): string {
      const text = this.parser.parseInline(tokens);
      // Narrower than DOMPurify's own filtering, which would allow tel: and
      // app deep links through.
      if (!isAllowedLinkHref(href)) return text;
      // Same normalization as marked's own cleanUrl: encode, then undo the
      // '%' → '%25' double-encoding so already-encoded URLs (e.g.
      // .../Caf%C3%A9) round-trip unchanged instead of ending up broken.
      // (javascript: and friends are stripped later by DOMPurify.)
      let safeHref: string;
      try {
        safeHref = encodeURI(href).replace(/%25/g, '%');
      } catch {
        return text;
      }
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
