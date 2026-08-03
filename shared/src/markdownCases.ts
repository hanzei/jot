// The conformance corpus for Jot's Markdown support.
//
// This is the single list of inputs both clients' renderer tests run against —
// webapp/src/utils/__tests__/markdown.test.ts and
// mobile/__tests__/markdown.test.ts. Each side keeps its own expectations
// (marked emits HTML, markdown-it feeds a React Native AST) but both assert one
// expectation per id and fail if an id here has none, so a case can never be
// covered on one client and forgotten on the other.
//
// Adding a case here deliberately breaks both suites until both are updated.
// The behaviour each case pins is specified in docs/specs/markdown-rendering.md.

export interface MarkdownCase {
  /** Stable identifier; both clients key their expectations off it. */
  id: string;
  /** Markdown source handed to the renderer. */
  markdown: string;
  /** What the reader ends up seeing, in prose. */
  expected: string;
}

export const MARKDOWN_CASES: MarkdownCase[] = [
  // Inline emphasis
  { id: 'bold', markdown: '**hello**', expected: 'bold text' },
  { id: 'italic', markdown: '*hello*', expected: 'italic text' },
  { id: 'strikethrough', markdown: '~~hello~~', expected: 'struck-through text' },

  // Headings: h1-h3 get their own sizes, h4-h6 render as bold body text
  { id: 'heading-1', markdown: '# Top heading', expected: 'a level 1 heading' },
  { id: 'heading-3', markdown: '### Third heading', expected: 'a level 3 heading' },
  { id: 'heading-4-bold', markdown: '#### Fourth heading', expected: 'bold text at body size' },
  { id: 'heading-6-bold', markdown: '###### Sixth heading', expected: 'bold text at body size' },

  // Code
  { id: 'inline-code', markdown: '`code`', expected: 'inline code' },
  { id: 'fenced-code', markdown: '```js\nconst a = 1;\n```', expected: 'a code block with block layout' },
  { id: 'indented-code', markdown: '    indented code', expected: 'a code block with block layout' },
  {
    id: 'task-marker-in-code',
    markdown: '```\n- [x] not a checkbox\n```',
    expected: 'a code block with the checkbox syntax left alone',
  },

  // Lists
  { id: 'bullet-list', markdown: '- item', expected: 'a bullet list' },
  { id: 'ordered-list', markdown: '1. item', expected: 'an ordered list' },
  { id: 'task-unchecked', markdown: '- [ ] todo', expected: 'a list item reading "☐ todo"' },
  { id: 'task-checked', markdown: '- [x] done', expected: 'a list item reading "☑ done"' },
  { id: 'task-checked-uppercase', markdown: '- [X] done', expected: 'a list item reading "☑ done"' },
  { id: 'task-marker-outside-list', markdown: '[x] not a task', expected: 'literal text, no checkbox' },

  // Blocks
  { id: 'blockquote', markdown: '> quote', expected: 'a blockquote' },
  { id: 'hr-dashes', markdown: 'above\n\n---\n\nbelow', expected: 'a horizontal rule' },
  { id: 'hr-stars', markdown: 'above\n\n***\n\nbelow', expected: 'a horizontal rule' },

  // Links
  { id: 'inline-link', markdown: '[text](https://example.com)', expected: 'a link labelled "text"' },
  { id: 'bare-url', markdown: 'visit https://example.com now', expected: 'an autolinked URL' },
  { id: 'mailto-link', markdown: '[mail](mailto:a@b.com)', expected: 'a link labelled "mail"' },
  { id: 'tel-link', markdown: '[call](tel:+15550100)', expected: 'plain text "call", not a link' },
  { id: 'javascript-link', markdown: '[click](javascript:alert(1))', expected: 'plain text "click", not a link' },
  { id: 'relative-link', markdown: '[rel](/dashboard)', expected: 'plain text "rel", not a link' },

  // Images: never rendered, shown as literal source
  {
    id: 'image',
    markdown: '![alt text](https://example.com/y.png)',
    expected: 'literal source: ![alt text](https://example.com/y.png)',
  },
  {
    id: 'image-with-title',
    markdown: '![alt](https://example.com/y.png "the title")',
    expected: 'literal source including the title',
  },
  {
    id: 'image-empty-alt',
    markdown: '![](https://example.com/y.png)',
    expected: 'literal source with empty brackets, nothing clickable',
  },
  {
    id: 'image-inline-in-paragraph',
    markdown: 'see ![a](https://example.com/y.png) here',
    expected: 'literal source inline in the sentence',
  },

  // Tables: never rendered, shown as literal source
  { id: 'table', markdown: 'a | b\n--- | ---\n1 | 2', expected: 'literal source, header row included' },

  // No smart typography
  { id: 'typography-dashes', markdown: 'a -- b', expected: 'literal "--", not an en dash' },
  { id: 'typography-quotes', markdown: 'say "hi"', expected: 'literal straight quotes' },

  // Whitespace and raw HTML
  { id: 'soft-break', markdown: 'first\nsecond', expected: 'a line break between the two words' },
  { id: 'raw-html', markdown: '<b>bold</b> text', expected: 'literal source: <b>bold</b> text' },
  {
    id: 'raw-html-script',
    markdown: '<script>alert(1)</script>',
    expected: 'literal source, inert — nothing executed',
  },
];
