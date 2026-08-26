// The conformance corpora for Jot's Markdown support.
//
// There are two, because Jot renders two different feature sets, and each has
// its own suite per client:
//
// - MARKDOWN_CASES      — text-note content, the full set (docs/specs §2)
//     webapp/src/utils/__tests__/markdown.test.ts
//     mobile/__tests__/markdown.test.tsx
// - MARKDOWN_ITEM_CASES — list-item text, the inline subset (docs/specs §2.1)
//     webapp/src/utils/__tests__/inlineMarkdown.test.ts
//     mobile/__tests__/inlineMarkdown.test.tsx
//     shared/src/__tests__/inlineMarkdown.test.ts (at the normalizer)
//
// Each side keeps its own expectations — marked emits HTML, mobile builds a
// React Native tree — but every suite asserts one expectation per id and fails
// if an id here has none, so a case can never be covered on one client and
// forgotten on the other.
//
// Adding a case to either corpus deliberately breaks that corpus's suites until
// all of them are updated. The behaviour each case pins is specified in
// docs/specs/markdown-rendering.md.

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
  { id: 'bare-url-www', markdown: 'visit www.example.com now', expected: 'an autolinked URL' },
  {
    id: 'bare-domain',
    markdown: 'visit example.com now',
    expected: 'plain text — GFM needs a scheme or www. to autolink',
  },
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
  {
    id: 'table-cell-url',
    markdown: 'a | b\n--- | ---\nhttps://example.com | 2',
    expected: 'literal source — a URL in a cell is text, not a link',
  },

  // No smart typography
  { id: 'typography-dashes', markdown: 'a -- b', expected: 'literal "--", not an en dash' },
  { id: 'typography-quotes', markdown: 'say "hi"', expected: 'literal straight quotes' },

  // Whitespace and raw HTML
  { id: 'soft-break', markdown: 'first\nsecond', expected: 'a line break between the two words' },
  { id: 'raw-html', markdown: '<b>bold</b> text', expected: 'literal source: <b>bold</b> text' },
  {
    id: 'raw-html-attribute-url',
    markdown: '<a href="https://example.com">x</a>',
    expected: 'literal source — the URL in the attribute is not a link',
  },
  {
    id: 'raw-html-block-swallows-markdown',
    markdown: '<div>\n**bold**\n</div>',
    expected: 'literal source end to end, the ** included',
  },
  {
    id: 'raw-html-script',
    markdown: '<script>alert(1)</script>',
    expected: 'literal source, inert — nothing executed',
  },
];

/**
 * The corpus for list-note item text, which renders an inline-only subset.
 *
 * The block cases below are the load-bearing ones: an item is itself a list item
 * with its own checkbox and nesting, so heading, list, rule and fence syntax has
 * to stay literal. It does so because items are lexed as inline content, not
 * because anything strips it — these cases are what would catch a renderer that
 * started lexing items as blocks.
 */
export const MARKDOWN_ITEM_CASES: MarkdownCase[] = [
  // The supported subset
  { id: 'item-bold', markdown: 'buy **milk**', expected: 'bold "milk"' },
  { id: 'item-italic', markdown: 'buy *milk*', expected: 'italic "milk"' },
  { id: 'item-strike', markdown: 'buy ~~milk~~', expected: 'struck-through "milk"' },
  { id: 'item-code', markdown: 'run `npm ci`', expected: 'inline code' },
  { id: 'item-nested-emphasis', markdown: '**bold *and italic***', expected: 'italic nested inside bold' },

  // Links, under the same scheme policy as text notes
  { id: 'item-link', markdown: '[docs](https://example.com)', expected: 'a link labelled "docs"' },
  { id: 'item-link-formatted-label', markdown: '[**docs**](https://example.com)', expected: 'a link with a bold label' },
  { id: 'item-bare-url', markdown: 'see https://example.com', expected: 'an autolinked URL' },
  { id: 'item-bare-url-www', markdown: 'see www.example.com', expected: 'an autolinked URL' },
  {
    id: 'item-bare-domain',
    markdown: 'see example.com',
    expected: 'plain text — GFM needs a scheme or www. to autolink',
  },
  { id: 'item-mailto', markdown: '[mail](mailto:a@b.com)', expected: 'a link labelled "mail"' },
  { id: 'item-tel-link', markdown: '[call](tel:+15550100)', expected: 'plain text "call", not a link' },
  {
    id: 'item-javascript-link',
    markdown: '[click](javascript:alert(1))',
    expected: 'plain text "click", not a link',
  },
  { id: 'item-relative-link', markdown: '[rel](/dashboard)', expected: 'plain text "rel", not a link' },
  {
    id: 'item-empty-link-label',
    markdown: '[](https://example.com)',
    expected: 'a link labelled with its own URL — never an invisible target',
  },

  // Block syntax stays literal: the item is already a list item
  { id: 'item-heading-literal', markdown: '# not a heading', expected: 'literal text including the #' },
  { id: 'item-bullet-literal', markdown: '- not a bullet', expected: 'literal text including the -' },
  { id: 'item-ordered-literal', markdown: '1. not a list', expected: 'literal text including the 1.' },
  {
    id: 'item-task-literal',
    markdown: '- [ ] not a checkbox',
    expected: 'literal text — the item has its own checkbox',
  },
  { id: 'item-hr-literal', markdown: '---', expected: 'literal text, no rule' },
  { id: 'item-blockquote-literal', markdown: '> not a quote', expected: 'literal text including the >' },
  { id: 'item-table-literal', markdown: 'a | b', expected: 'literal text including the pipe' },

  // Degraded to source, as in text notes
  {
    id: 'item-image',
    markdown: 'see ![alt](https://example.com/y.png)',
    expected: 'literal source: ![alt](https://example.com/y.png)',
  },
  { id: 'item-raw-html', markdown: '<b>bold</b> text', expected: 'literal source: <b>bold</b> text' },
  {
    id: 'item-raw-html-script',
    markdown: '<script>alert(1)</script>',
    expected: 'literal source, inert — nothing executed',
  },

  // Plain text that must survive untouched
  { id: 'item-escaped-star', markdown: '\\*not emphasis\\*', expected: 'literal asterisks, no emphasis' },
  { id: 'item-arithmetic', markdown: '2 * 3 * 4', expected: 'literal asterisks — CommonMark needs no space after the opener' },
  { id: 'item-underscored-word', markdown: 'my_file_name.txt', expected: 'literal underscores, no emphasis' },
  { id: 'item-ampersand', markdown: 'salt & pepper < 5', expected: 'literal & and <, correctly escaped' },
  { id: 'item-plain', markdown: 'milk', expected: 'plain text, unchanged' },
];
