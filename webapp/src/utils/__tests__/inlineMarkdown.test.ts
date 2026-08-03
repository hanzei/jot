import { describe, it, expect } from 'vitest';
import { MARKDOWN_ITEM_CASES } from '@jot/shared';
import { renderInlineMarkdown } from '../markdown';

function render(id: string): string {
  const testCase = MARKDOWN_ITEM_CASES.find((c) => c.id === id);
  if (!testCase) throw new Error(`unknown markdown item case: ${id}`);
  return renderInlineMarkdown(testCase.markdown);
}

// One assertion per case in the shared item corpus (shared/src/markdownCases.ts).
// The mobile suite runs the same corpus through its own renderer; the coverage
// test below is what keeps the two from drifting apart.
const conformance: Record<string, () => void> = {
  'item-bold': () => expect(render('item-bold')).toBe('buy <strong>milk</strong>'),
  'item-italic': () => expect(render('item-italic')).toBe('buy <em>milk</em>'),
  'item-strike': () => expect(render('item-strike')).toBe('buy <del>milk</del>'),
  'item-code': () => expect(render('item-code')).toBe('run <code>npm ci</code>'),
  'item-nested-emphasis': () =>
    expect(render('item-nested-emphasis')).toBe('<strong>bold <em>and italic</em></strong>'),

  'item-link': () =>
    expect(render('item-link')).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>',
    ),
  'item-link-formatted-label': () => {
    const html = render('item-link-formatted-label');
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('<strong>docs</strong>');
  },
  'item-bare-url': () => {
    const html = render('item-bare-url');
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('>https://example.com</a>');
  },
  'item-bare-url-www': () => {
    // GFM normalizes a www. autolink to an http:// target.
    const html = render('item-bare-url-www');
    expect(html).toContain('<a href="http://www.example.com"');
    expect(html).toContain('>www.example.com</a>');
  },
  'item-bare-domain': () => {
    const html = render('item-bare-domain');
    expect(html).toBe('see example.com');
    expect(html).not.toContain('<a');
  },
  'item-mailto': () => expect(render('item-mailto')).toContain('<a href="mailto:a@b.com"'),
  'item-tel-link': () => {
    const html = render('item-tel-link');
    expect(html).toBe('call');
    expect(html).not.toContain('<a');
  },
  'item-javascript-link': () => {
    const html = render('item-javascript-link');
    expect(html).toBe('click');
    expect(html).not.toContain('<a');
  },
  'item-relative-link': () => {
    const html = render('item-relative-link');
    expect(html).toBe('rel');
    expect(html).not.toContain('<a');
  },
  'item-empty-link-label': () =>
    // Never an invisible tappable region: the target becomes its own label.
    expect(render('item-empty-link-label')).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>',
    ),

  // Block syntax stays literal because items are lexed as inline content.
  'item-heading-literal': () => {
    const html = render('item-heading-literal');
    expect(html).toBe('# not a heading');
    expect(html).not.toContain('<h1');
  },
  'item-bullet-literal': () => {
    const html = render('item-bullet-literal');
    expect(html).toBe('- not a bullet');
    expect(html).not.toContain('<li');
  },
  'item-ordered-literal': () => {
    const html = render('item-ordered-literal');
    expect(html).toBe('1. not a list');
    expect(html).not.toContain('<ol');
  },
  'item-task-literal': () => {
    const html = render('item-task-literal');
    expect(html).toBe('- [ ] not a checkbox');
    expect(html).not.toContain('☐');
  },
  'item-hr-literal': () => {
    const html = render('item-hr-literal');
    expect(html).toBe('---');
    expect(html).not.toContain('<hr');
  },
  'item-blockquote-literal': () => {
    const html = render('item-blockquote-literal');
    expect(html).toBe('&gt; not a quote');
    expect(html).not.toContain('<blockquote');
  },
  'item-table-literal': () => {
    const html = render('item-table-literal');
    expect(html).toBe('a | b');
    expect(html).not.toContain('<table');
  },

  'item-image': () => {
    const html = render('item-image');
    expect(html).toBe('see ![alt](https://example.com/y.png)');
    expect(html).not.toContain('<img');
  },
  'item-raw-html': () => {
    const html = render('item-raw-html');
    expect(html).toBe('&lt;b&gt;bold&lt;/b&gt; text');
    expect(html).not.toContain('<b>');
  },
  'item-raw-html-script': () => {
    const html = render('item-raw-html-script');
    expect(html).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script');
  },

  'item-escaped-star': () => {
    const html = render('item-escaped-star');
    expect(html).toBe('*not emphasis*');
    expect(html).not.toContain('<em>');
  },
  'item-arithmetic': () => {
    const html = render('item-arithmetic');
    expect(html).toBe('2 * 3 * 4');
    expect(html).not.toContain('<em>');
  },
  'item-underscored-word': () => {
    const html = render('item-underscored-word');
    expect(html).toBe('my_file_name.txt');
    expect(html).not.toContain('<em>');
  },
  'item-ampersand': () => expect(render('item-ampersand')).toBe('salt &amp; pepper &lt; 5'),
  'item-plain': () => expect(render('item-plain')).toBe('milk'),
};

describe('renderInlineMarkdown', () => {
  it('has an expectation for every shared item case', () => {
    const missing = MARKDOWN_ITEM_CASES.filter((c) => !(c.id in conformance)).map((c) => c.id);
    expect(missing).toEqual([]);
    const stale = Object.keys(conformance).filter(
      (id) => !MARKDOWN_ITEM_CASES.some((c) => c.id === id),
    );
    expect(stale).toEqual([]);
  });

  for (const testCase of MARKDOWN_ITEM_CASES) {
    it(`${testCase.id}: ${testCase.expected}`, () => {
      conformance[testCase.id]();
    });
  }

  it('returns empty string for blank input', () => {
    expect(renderInlineMarkdown('')).toBe('');
    expect(renderInlineMarkdown('   ')).toBe('');
  });

  it('emits a <br> for a newline rather than a bare newline, which HTML would collapse', () => {
    expect(renderInlineMarkdown('a\nb')).toBe('a<br>b');
  });

  it('keeps already percent-encoded hrefs intact instead of double-encoding them', () => {
    const html = renderInlineMarkdown('[café](https://en.wikipedia.org/wiki/Caf%C3%A9)');
    expect(html).toContain('href="https://en.wikipedia.org/wiki/Caf%C3%A9"');
    expect(html).not.toContain('%25C3');
  });

  it('renders the link text without an anchor when the href cannot be encoded', () => {
    // A lone surrogate makes encodeURI throw; the renderer falls back to text.
    const html = renderInlineMarkdown('[broken](https://example.com/\uD800)');
    expect(html).toContain('broken');
    expect(html).not.toContain('<a');
  });

  it('produces no block elements for any corpus case', () => {
    // The subset is inline-only by construction. This is the assertion that
    // fails first if items ever start being parsed as a document.
    for (const testCase of MARKDOWN_ITEM_CASES) {
      const html = renderInlineMarkdown(testCase.markdown);
      expect(html, testCase.id).not.toMatch(/<(p|div|h[1-6]|ul|ol|li|blockquote|pre|hr|table)\b/);
    }
  });
});
