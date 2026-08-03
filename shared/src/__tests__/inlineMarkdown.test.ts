import { describe, it, expect } from 'vitest';
import { Lexer } from 'marked';
import { normalizeInlineTokens, INLINE_LEXER_OPTIONS, type InlineNode } from '../inlineMarkdown';
import { MARKDOWN_ITEM_CASES } from '../markdownCases';

// `marked` is a devDependency here purely so this suite can lex — inlineMarkdown.ts
// itself only type-imports it, and @jot/shared must stay free of runtime deps.

function lex(markdown: string): InlineNode[] {
  return normalizeInlineTokens(Lexer.lexInline(markdown, INLINE_LEXER_OPTIONS));
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

  it('turns a newline into a br node, not a text newline', () => {
    expect(summarize(lex('a\nb'))).toBe('text("a")brtext("b")');
  });
});
