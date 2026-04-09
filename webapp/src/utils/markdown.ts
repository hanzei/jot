import { marked, Tokens } from 'marked';
import DOMPurify from 'dompurify';

marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    link({ href, tokens }: Tokens.Link): string {
      const text = this.parser.parseInline(tokens);
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

const ALLOWED_TAGS = [
  'p', 'br', 'h2', 'h3',
  'strong', 'em',
  'ul', 'ol', 'li',
  'blockquote', 'code',
  'a',
];
const ALLOWED_ATTR = ['href', 'target', 'rel'];

export function renderMarkdown(content: string): string {
  if (!content.trim()) return '';
  const raw = marked(content) as string;
  return DOMPurify.sanitize(raw, { ALLOWED_TAGS, ALLOWED_ATTR });
}
