import { describe, it, expect } from 'vitest';
import { Lexer } from 'marked';
import { normalizeBlockTokens, BLOCK_LEXER_OPTIONS, type BlockNode } from '../blockMarkdown';
import { type InlineNode } from '../inlineMarkdown';
import { MARKDOWN_CASES } from '../markdownCases';

// The text-note corpus a third time, at the normalizer — where the policy
// actually lives. The two client suites (webapp/src/utils/__tests__/markdown.test.ts,
// mobile/__tests__/markdown.test.tsx) run the same cases end to end through
// their own renderers; this one pins what both of them are handed.
//
// `marked` is a devDependency here purely so this suite can lex — blockMarkdown.ts
// itself declares the token shape structurally and imports nothing from it.

/**
 * Renders a node tree to a compact string so a case's expectation reads as one
 * line, and fails loudly on structure as well as on text. `+` separates inline
 * nodes, ` ` separates blocks, `|` separates list items.
 */
function inline(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return JSON.stringify(node.value);
        case 'code':
          return `code(${JSON.stringify(node.value)})`;
        case 'br':
          return 'br';
        case 'link':
          return `link(${node.href}: ${inline(node.children)})`;
        default:
          return `${node.type}(${inline(node.children)})`;
      }
    })
    .join('+');
}

function summarize(nodes: BlockNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'paragraph':
          return `p(${inline(node.children)})`;
        case 'heading':
          return `h${node.depth}(${inline(node.children)})`;
        case 'code':
          return `pre(${JSON.stringify(node.text)})`;
        case 'blockquote':
          return `quote[${summarize(node.children)}]`;
        case 'hr':
          return 'hr';
        case 'list': {
          const start = node.start !== 1 ? `@${node.start}` : '';
          const loose = node.loose ? '~loose' : '';
          const items = node.items.map((item) => summarize(item)).join(' | ');
          return `${node.ordered ? 'ol' : 'ul'}${start}${loose}[${items}]`;
        }
      }
    })
    .join(' ');
}

function normalize(markdown: string): string {
  return summarize(normalizeBlockTokens(Lexer.lex(markdown, BLOCK_LEXER_OPTIONS)));
}

const conformance: Record<string, string> = {
  bold: 'p(strong("hello"))',
  italic: 'p(em("hello"))',
  strikethrough: 'p(del("hello"))',

  'heading-1': 'h1("Top heading")',
  'heading-3': 'h3("Third heading")',
  // Kept as real headings and styled down by each client, never rewritten.
  'heading-4-bold': 'h4("Fourth heading")',
  'heading-6-bold': 'h6("Sixth heading")',

  'inline-code': 'p(code("code"))',
  'fenced-code': 'pre("const a = 1;")',
  'indented-code': 'pre("indented code")',
  // The checkbox swap is structural, not textual, so it cannot reach inside a
  // fence — which is what the positional markdown-it version kept getting wrong.
  'task-marker-in-code': 'pre("- [x] not a checkbox")',

  'bullet-list': 'ul[p("item")]',
  'ordered-list': 'ol[p("item")]',
  'task-unchecked': 'ul[p("☐ "+"todo")]',
  'task-checked': 'ul[p("☑ "+"done")]',
  'task-checked-uppercase': 'ul[p("☑ "+"done")]',
  'task-marker-outside-list': 'p("[x] not a task")',

  blockquote: 'quote[p("quote")]',
  'hr-dashes': 'p("above") hr p("below")',
  'hr-stars': 'p("above") hr p("below")',

  'inline-link': 'p(link(https://example.com: "text"))',
  'bare-url': 'p("visit "+link(https://example.com: "https://example.com")+" now")',
  // marked normalizes a `www.` autolink to an http:// target; both clients accept it.
  'bare-url-www': 'p("visit "+link(http://www.example.com: "www.example.com")+" now")',
  'bare-domain': 'p("visit example.com now")',
  'mailto-link': 'p(link(mailto:a@b.com: "mail"))',
  // Refused schemes keep their label and lose the link entirely.
  'tel-link': 'p("call")',
  'javascript-link': 'p("click")',
  'relative-link': 'p("rel")',

  image: 'p("![alt text](https://example.com/y.png)")',
  'image-with-title': 'p("![alt](https://example.com/y.png \\"the title\\")")',
  'image-empty-alt': 'p("![](https://example.com/y.png)")',
  'image-inline-in-paragraph': 'p("see "+"![a](https://example.com/y.png)"+" here")',

  table: 'p("a | b\\n--- | ---\\n1 | 2")',
  // The parsed cells are discarded with the table, so the URL never became a link.
  'table-cell-url': 'p("a | b\\n--- | ---\\nhttps://example.com | 2")',

  'typography-dashes': 'p("a -- b")',
  'typography-quotes': 'p("say \\"hi\\"")',

  'soft-break': 'p("first"+br+"second")',
  'raw-html': 'p("<b>"+"bold"+"</b>"+" text")',
  'raw-html-attribute-url': 'p("<a href=\\"https://example.com\\">"+"x"+"</a>")',
  'raw-html-block-swallows-markdown': 'p("<div>\\n**bold**\\n</div>")',
  'raw-html-script': 'p("<script>alert(1)</script>")',
};

describe('normalizeBlockTokens', () => {
  it('has an expectation for every shared conformance case', () => {
    const missing = MARKDOWN_CASES.filter((c) => !(c.id in conformance)).map((c) => c.id);
    expect(missing).toEqual([]);
    const stale = Object.keys(conformance).filter(
      (id) => !MARKDOWN_CASES.some((c) => c.id === id),
    );
    expect(stale).toEqual([]);
  });

  for (const testCase of MARKDOWN_CASES) {
    it(`${testCase.id}: ${testCase.expected}`, () => {
      expect(normalize(testCase.markdown)).toBe(conformance[testCase.id]);
    });
  }

  // List shapes the corpus does not reach. Every one of them is somewhere the
  // walk has real logic — the run buffer, recursion, or a field a renderer
  // needs — so they would otherwise be covered only by whichever client
  // happened to render them.
  describe('list structure', () => {
    it('nests a child list inside its parent item', () => {
      expect(normalize('- a\n  - b')).toBe('ul[p("a") ul[p("b")]]');
    });

    it('keeps an ordered list\u2019s first number', () => {
      expect(normalize('3. a\n4. b')).toBe('ol@3[p("a") | p("b")]');
    });

    // The flag a renderer needs to decide whether an item wraps its text in a
    // paragraph: CommonMark's tight/loose distinction, which cannot be
    // recovered from the item's shape once the run buffer has flushed.
    it('marks a loose list, and keeps its items apart from a tight one', () => {
      expect(normalize('- a\n\n- b')).toBe('ul~loose[p("a") | p("b")]');
      expect(normalize('- a\n- b')).toBe('ul[p("a") | p("b")]');
    });

    it('puts a loose task marker on the same line as its text', () => {
      expect(normalize('- [x] a\n\n- [ ] b')).toBe('ul~loose[p("☑ "+"a") | p("☐ "+"b")]');
    });

    it('holds blocks inside a blockquote, including a list and a fence', () => {
      expect(normalize('> quote\n>\n> - a\n>\n> ```\n> x\n> ```')).toBe(
        'quote[p("quote") ul[p("a")] pre("x")]',
      );
    });
  });

  it('renders a link reference definition as nothing, its links resolved', () => {
    // The one token neither rendered nor degraded to source: marked has already
    // substituted the target, so there is no source left to show.
    expect(normalize('[a]: https://example.com\n\ntext [a]')).toBe(
      'p("text "+link(https://example.com: "a"))',
    );
  });

  it('produces nothing for blank input', () => {
    expect(normalizeBlockTokens(Lexer.lex('', BLOCK_LEXER_OPTIONS))).toEqual([]);
    expect(normalizeBlockTokens(Lexer.lex('   ', BLOCK_LEXER_OPTIONS))).toEqual([]);
  });
});
