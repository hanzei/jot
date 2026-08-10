import { describe, it, expect } from 'vitest';
import { Lexer } from 'marked';
import {
  normalizeInlineTokens,
  flattenInlineNodes,
  inlineSourceOffset,
  inlineRendersAsSource,
  INLINE_LEXER_OPTIONS,
  type InlineNode,
} from '../inlineMarkdown';
import { MARKDOWN_ITEM_CASES } from '../markdownCases';

// `marked` is a devDependency here purely so this suite can lex — inlineMarkdown.ts
// itself only type-imports it, and @jot/shared must stay free of runtime deps.

function lex(markdown: string): InlineNode[] {
  return normalizeInlineTokens(Lexer.lexInline(markdown, INLINE_LEXER_OPTIONS));
}

/** The same nodes, annotated with where each one came from in `markdown`. */
function lexWithSource(markdown: string): InlineNode[] {
  return normalizeInlineTokens(Lexer.lexInline(markdown, INLINE_LEXER_OPTIONS), 0);
}

/**
 * Renders a node tree to a compact string so a case's expectation reads as one
 * line. `text("buy ")strong(text("milk"))` is easier to review against the spec
 * than a nested object literal, and it fails loudly on structure as well as text.
 */
function summarize(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return `text(${JSON.stringify(node.value)})`;
        case 'code':
          return `code(${JSON.stringify(node.value)})`;
        case 'br':
          return 'br';
        case 'link':
          return `link(${node.href}: ${summarize(node.children)})`;
        default:
          return `${node.type}(${summarize(node.children)})`;
      }
    })
    .join('');
}

// One entry per MARKDOWN_ITEM_CASES id. The final test in this file fails if an
// id is missing, so a new case cannot be added to the corpus without a decision
// being recorded here.
const EXPECTED: Record<string, string> = {
  // The supported subset
  'item-bold': 'text("buy ")strong(text("milk"))',
  'item-italic': 'text("buy ")em(text("milk"))',
  'item-strike': 'text("buy ")del(text("milk"))',
  'item-code': 'text("run ")code("npm ci")',
  'item-nested-emphasis': 'strong(text("bold ")em(text("and italic")))',

  // Links
  'item-link': 'link(https://example.com: text("docs"))',
  'item-link-formatted-label': 'link(https://example.com: strong(text("docs")))',
  'item-bare-url': 'text("see ")link(https://example.com: text("https://example.com"))',
  'item-bare-url-www': 'text("see ")link(http://www.example.com: text("www.example.com"))',
  'item-bare-domain': 'text("see example.com")',
  'item-mailto': 'link(mailto:a@b.com: text("mail"))',
  // Disallowed schemes keep the label and lose only the link.
  'item-tel-link': 'text("call")',
  'item-javascript-link': 'text("click")',
  'item-relative-link': 'text("rel")',
  'item-empty-link-label': 'link(https://example.com: text("https://example.com"))',

  // Block syntax stays literal
  'item-heading-literal': 'text("# not a heading")',
  'item-bullet-literal': 'text("- not a bullet")',
  'item-ordered-literal': 'text("1. not a list")',
  'item-task-literal': 'text("- [ ] not a checkbox")',
  'item-hr-literal': 'text("---")',
  'item-blockquote-literal': 'text("> not a quote")',
  'item-table-literal': 'text("a | b")',

  // Degraded to source
  'item-image': 'text("see ")text("![alt](https://example.com/y.png)")',
  'item-raw-html': 'text("<b>")text("bold")text("</b>")text(" text")',
  'item-raw-html-script': 'text("<script>")text("alert(1)")text("</script>")',

  // Plain text
  'item-escaped-star': 'text("*")text("not emphasis")text("*")',
  'item-arithmetic': 'text("2 * 3 * 4")',
  'item-underscored-word': 'text("my_file_name.txt")',
  'item-ampersand': 'text("salt & pepper < 5")',
  'item-plain': 'text("milk")',
};

describe('normalizeInlineTokens', () => {
  for (const testCase of MARKDOWN_ITEM_CASES) {
    it(`${testCase.id}: ${testCase.expected}`, () => {
      const expected = EXPECTED[testCase.id];
      expect(expected, `no expectation recorded for case "${testCase.id}"`).toBeDefined();
      expect(summarize(lex(testCase.markdown))).toBe(expected);
    });
  }

  it('covers every case in the corpus', () => {
    const missing = MARKDOWN_ITEM_CASES.filter((c) => EXPECTED[c.id] === undefined).map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it('records no expectation for a case that no longer exists', () => {
    const ids = new Set(MARKDOWN_ITEM_CASES.map((c) => c.id));
    expect(Object.keys(EXPECTED).filter((id) => !ids.has(id))).toEqual([]);
  });

  it('returns nothing for empty input', () => {
    expect(lex('')).toEqual([]);
  });

  describe('flattenInlineNodes', () => {
    it('drops formatting and keeps the words, for every corpus case', () => {
      // The flattened form is what an aria-label announces, so no case may leak
      // a syntax marker that the rendered output does not show.
      for (const testCase of MARKDOWN_ITEM_CASES) {
        expect(flattenInlineNodes(lex(testCase.markdown)), testCase.id).not.toMatch(
          /\*\*|~~|(?<!\\)`/,
        );
      }
    });

    it('keeps a link label rather than its target', () => {
      expect(flattenInlineNodes(lex('[docs](https://example.com)'))).toBe('docs');
    });

    it('keeps the words inside emphasis and code', () => {
      expect(flattenInlineNodes(lex('buy **milk** and run `npm ci`'))).toBe('buy milk and run npm ci');
    });

    it('keeps literal source that the renderer also shows literally', () => {
      expect(flattenInlineNodes(lex('# not a heading'))).toBe('# not a heading');
      expect(flattenInlineNodes(lex('see ![alt](https://example.com/y.png)'))).toBe(
        'see ![alt](https://example.com/y.png)',
      );
    });

    it('reads a line break as a word gap', () => {
      expect(flattenInlineNodes(lex('a\nb'))).toBe('a b');
    });
  });

  it('turns a newline into a br node, not a text newline', () => {
    expect(summarize(lex('a\nb'))).toBe('text("a")brtext("b")');
  });

  describe('source tracking', () => {
    it('records no spans unless a source offset is passed', () => {
      for (const node of lex('buy **milk**')) {
        expect(node.src).toBeUndefined();
      }
    });

    it('spans the content of a construct, not its delimiters', () => {
      const nodes = lexWithSource('buy **milk**');
      const text = nodes[0]!;
      const strong = nodes[1]!;
      expect(text.src).toEqual({ start: 0, end: 4 });
      // The strong node covers `**milk**`; the text inside it covers `milk`.
      expect(strong.src).toEqual({ start: 4, end: 12 });
      expect(strong.type === 'strong' && strong.children[0]?.src).toEqual({ start: 6, end: 10 });
    });

    it('spans code content inside its backticks', () => {
      const code = lexWithSource('run `npm ci`')[1]!;
      expect(code.src).toEqual({ start: 5, end: 12 });
    });
  });

  describe('inlineSourceOffset', () => {
    /** The source offset a click at `renderedOffset` characters in should give. */
    function offsetIn(markdown: string, renderedOffset: number): number {
      return inlineSourceOffset(lexWithSource(markdown), renderedOffset, markdown.length);
    }

    it('maps a click inside bold text past the markers', () => {
      // Rendered "buy milk"; the m of milk is at 4 on screen and 6 in source.
      expect(offsetIn('buy **milk**', 0)).toBe(0);
      expect(offsetIn('buy **milk**', 4)).toBe(6);
      expect(offsetIn('buy **milk**', 6)).toBe(8);
    });

    it('maps a click inside code past the backtick', () => {
      expect(offsetIn('run `npm ci`', 4)).toBe(5);
    });

    it('maps a click inside a link label past the bracket', () => {
      expect(offsetIn('[docs](https://example.com)', 0)).toBe(1);
      expect(offsetIn('[docs](https://example.com)', 2)).toBe(3);
    });

    it('puts a click past the end of the rendered text at the end of the source', () => {
      expect(offsetIn('buy **milk**', 8)).toBe(12);
      expect(offsetIn('buy **milk**', 99)).toBe(12);
      expect(offsetIn('[docs](https://example.com)', 4)).toBe(27);
    });

    it('counts a line break as one position', () => {
      expect(offsetIn('a\nb', 1)).toBe(1);
      expect(offsetIn('a\nb', 2)).toBe(2);
    });

    it('keeps a click inside a construct that renders at a different length within it', () => {
      // A literal image is rebuilt rather than echoed, so an offset inside it is
      // approximate — but it must still land inside the construct.
      const source = 'see ![alt](https://example.com/y.png)';
      const offset = inlineSourceOffset(lexWithSource(source), 10, source.length);
      expect(offset).toBeGreaterThanOrEqual(4);
      expect(offset).toBeLessThanOrEqual(source.length);
    });

    it('falls back to the end of the source when nodes carry no spans', () => {
      expect(inlineSourceOffset(lex('buy **milk**'), 4, 12)).toBe(12);
    });
  });

  describe('inlineRendersAsSource', () => {
    /** Every corpus case, split by whether rendering it changes what is shown. */
    const RENDERS_AS_SOURCE = new Set([
      'item-bare-domain',
      'item-heading-literal',
      'item-bullet-literal',
      'item-ordered-literal',
      'item-task-literal',
      'item-hr-literal',
      'item-blockquote-literal',
      'item-table-literal',
      'item-image',
      'item-raw-html',
      'item-raw-html-script',
      'item-arithmetic',
      'item-underscored-word',
      'item-ampersand',
      'item-plain',
    ]);

    for (const testCase of MARKDOWN_ITEM_CASES) {
      it(`${testCase.id}: ${RENDERS_AS_SOURCE.has(testCase.id) ? 'shows its source' : 'renders differently'}`, () => {
        expect(inlineRendersAsSource(lex(testCase.markdown), testCase.markdown)).toBe(
          RENDERS_AS_SOURCE.has(testCase.id),
        );
      });
    }

    it('treats a line break as showing its source', () => {
      // The textarea and the rendered form both put "b" on the second line.
      expect(inlineRendersAsSource(lex('a\nb'), 'a\nb')).toBe(true);
    });

    it('treats a dropped escape as a rendering change', () => {
      expect(inlineRendersAsSource(lex('\\*x\\*'), '\\*x\\*')).toBe(false);
    });

    it('treats code as a rendering change even when the characters match', () => {
      expect(inlineRendersAsSource(lex('`a`'), '`a`')).toBe(false);
    });
  });
});
