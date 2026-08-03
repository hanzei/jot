import React from 'react';
import { render } from '@testing-library/react-native';
import Markdown from 'react-native-markdown-display';
import { MARKDOWN_CASES } from '@jot/shared';
import { allowLinkPress, markdownParser, markdownRules } from '../src/utils/markdown';
import { compactMarkdownStyles, fullMarkdownStyles } from '../src/utils/markdownStyles';

// The mobile half of the shared conformance corpus (shared/src/markdownCases.ts);
// webapp/src/utils/__tests__/markdown.test.ts runs the same list through marked.
// The coverage test at the bottom is what keeps the two from drifting apart.
//
// Two assertion surfaces, because mobile splits the work in two:
//  - html(): markdown-it's own renderer over the exact token stream
//    react-native-markdown-display consumes. Everything the parser decides —
//    headings, images, tables, linkify, typography, checkboxes — is visible here.
//  - the <Markdown> tree: what the render rules do with those tokens, which is
//    where link schemes are enforced.

function markdownFor(id: string): string {
  const testCase = MARKDOWN_CASES.find((c) => c.id === id);
  if (!testCase) throw new Error(`unknown markdown case: ${id}`);
  return testCase.markdown;
}

function html(id: string): string {
  return (markdownParser as unknown as { render(src: string): string }).render(markdownFor(id));
}

type RenderedNode = { props?: Record<string, unknown>; children?: unknown[] } | string | null;

function renderCase(id: string): RenderedNode {
  return render(
    <Markdown markdownit={markdownParser} rules={markdownRules} onLinkPress={allowLinkPress}>
      {markdownFor(id)}
    </Markdown>,
  ).toJSON() as RenderedNode;
}

/** Every string in the rendered tree, i.e. what the user actually reads. */
function visibleText(node: RenderedNode): string {
  if (node === null) return '';
  if (typeof node === 'string') return node;
  return (node.children ?? []).map((child) => visibleText(child as RenderedNode)).join('');
}

/** The text of every tappable node — a link the user can follow. */
function tappableText(node: RenderedNode): string[] {
  if (node === null || typeof node === 'string') return [];
  const own = typeof node.props?.onPress === 'function' ? [visibleText(node)] : [];
  return own.concat(
    (node.children ?? []).flatMap((child) => tappableText(child as RenderedNode)),
  );
}

const conformance: Record<string, () => void> = {
  bold: () => expect(html('bold')).toContain('<strong>hello</strong>'),
  italic: () => expect(html('italic')).toContain('<em>hello</em>'),
  strikethrough: () => expect(html('strikethrough')).toContain('<s>hello</s>'),

  'heading-1': () => expect(html('heading-1')).toContain('<h1>Top heading</h1>'),
  'heading-3': () => expect(html('heading-3')).toContain('<h3>Third heading</h3>'),
  // Rendered as heading4/heading6 nodes; markdownStyles.ts gives them body size
  // and bold weight rather than a size of their own.
  'heading-4-bold': () => expect(html('heading-4-bold')).toContain('<h4>Fourth heading</h4>'),
  'heading-6-bold': () => expect(html('heading-6-bold')).toContain('<h6>Sixth heading</h6>'),

  'inline-code': () => expect(html('inline-code')).toContain('<code>code</code>'),
  'fenced-code': () => {
    expect(html('fenced-code')).toContain('<pre><code');
    expect(html('fenced-code')).toContain('const a = 1;');
  },
  'indented-code': () => {
    expect(html('indented-code')).toContain('<pre><code');
    expect(html('indented-code')).toContain('indented code');
  },
  'task-marker-in-code': () => {
    expect(html('task-marker-in-code')).toContain('<pre><code');
    expect(html('task-marker-in-code')).toContain('- [x] not a checkbox');
    expect(html('task-marker-in-code')).not.toContain('☑');
  },

  'bullet-list': () => expect(html('bullet-list')).toContain('<li>item</li>'),
  'ordered-list': () => {
    expect(html('ordered-list')).toContain('<ol>');
    expect(html('ordered-list')).toContain('<li>item</li>');
  },
  'task-unchecked': () => expect(html('task-unchecked')).toContain('<li>☐ todo</li>'),
  'task-checked': () => expect(html('task-checked')).toContain('<li>☑ done</li>'),
  'task-checked-uppercase': () =>
    expect(html('task-checked-uppercase')).toContain('<li>☑ done</li>'),
  'task-marker-outside-list': () => {
    expect(html('task-marker-outside-list')).toContain('[x] not a task');
    expect(html('task-marker-outside-list')).not.toContain('☑');
  },

  blockquote: () => expect(html('blockquote')).toContain('<blockquote>'),
  'hr-dashes': () => expect(html('hr-dashes')).toContain('<hr>'),
  'hr-stars': () => expect(html('hr-stars')).toContain('<hr>'),

  'inline-link': () => expect(tappableText(renderCase('inline-link'))).toEqual(['text']),
  'bare-url': () => {
    expect(html('bare-url')).toContain('href="https://example.com"');
    expect(tappableText(renderCase('bare-url'))).toEqual(['https://example.com']);
  },
  'bare-url-www': () => {
    expect(html('bare-url-www')).toContain('href="http://www.example.com"');
    expect(tappableText(renderCase('bare-url-www'))).toEqual(['www.example.com']);
  },
  'bare-domain': () => {
    const tree = renderCase('bare-domain');
    expect(visibleText(tree)).toBe('visit example.com now');
    expect(tappableText(tree)).toEqual([]);
  },
  'mailto-link': () => expect(tappableText(renderCase('mailto-link'))).toEqual(['mail']),
  'tel-link': () => {
    const tree = renderCase('tel-link');
    expect(visibleText(tree)).toContain('call');
    expect(tappableText(tree)).toEqual([]);
  },
  'javascript-link': () => expect(tappableText(renderCase('javascript-link'))).toEqual([]),
  'relative-link': () => {
    const tree = renderCase('relative-link');
    expect(visibleText(tree)).toContain('rel');
    expect(tappableText(tree)).toEqual([]);
  },

  image: () => {
    const tree = renderCase('image');
    expect(visibleText(tree)).toContain('![alt text](https://example.com/y.png)');
    expect(tappableText(tree)).toEqual([]);
  },
  'image-with-title': () =>
    expect(visibleText(renderCase('image-with-title'))).toContain(
      '![alt](https://example.com/y.png "the title")',
    ),
  'image-empty-alt': () => {
    const tree = renderCase('image-empty-alt');
    expect(visibleText(tree)).toContain('![](https://example.com/y.png)');
    // .disable('image') would leave an invisible clickable link here.
    expect(tappableText(tree)).toEqual([]);
  },
  'image-inline-in-paragraph': () =>
    expect(visibleText(renderCase('image-inline-in-paragraph'))).toContain(
      'see ![a](https://example.com/y.png) here',
    ),

  table: () => {
    expect(html('table')).not.toContain('<table');
    expect(visibleText(renderCase('table'))).toContain('a | b\n--- | ---\n1 | 2');
  },
  'table-cell-url': () => {
    const tree = renderCase('table-cell-url');
    expect(visibleText(tree)).toContain('a | b\n--- | ---\nhttps://example.com | 2');
    expect(tappableText(tree)).toEqual([]);
  },

  'typography-dashes': () => expect(visibleText(renderCase('typography-dashes'))).toBe('a -- b'),
  'typography-quotes': () => expect(visibleText(renderCase('typography-quotes'))).toBe('say "hi"'),

  'soft-break': () => expect(visibleText(renderCase('soft-break'))).toBe('first\nsecond'),
  'raw-html': () => expect(visibleText(renderCase('raw-html'))).toBe('<b>bold</b> text'),
  'raw-html-attribute-url': () => {
    const tree = renderCase('raw-html-attribute-url');
    expect(visibleText(tree)).toBe('<a href="https://example.com">x</a>');
    expect(tappableText(tree)).toEqual([]);
  },
  'raw-html-block-swallows-markdown': () =>
    expect(visibleText(renderCase('raw-html-block-swallows-markdown'))).toBe(
      '<div>\n**bold**\n</div>',
    ),
  'raw-html-script': () =>
    expect(visibleText(renderCase('raw-html-script'))).toBe('<script>alert(1)</script>'),
};

describe('markdown rendering', () => {
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
      conformance[testCase.id]();
    });
  }

  describe('heading styles', () => {
    it('renders h4-h6 at body size in bold, not as their own heading sizes', () => {
      for (const styles of [fullMarkdownStyles('#000'), compactMarkdownStyles('#000')]) {
        for (const level of ['heading4', 'heading5', 'heading6'] as const) {
          expect(styles[level].fontSize).toBe(styles.body.fontSize);
          expect(styles[level].fontWeight).toBe('700');
        }
      }
    });
  });

  describe('allowLinkPress', () => {
    it('allows the schemes Jot renders as links', () => {
      expect(allowLinkPress('https://example.com')).toBe(true);
      expect(allowLinkPress('http://example.com')).toBe(true);
      expect(allowLinkPress('mailto:a@b.com')).toBe(true);
    });

    it('blocks app deep links and everything else', () => {
      expect(allowLinkPress('tel:+15550100')).toBe(false);
      expect(allowLinkPress('sms:+15550100')).toBe(false);
      expect(allowLinkPress('jot://notes/1')).toBe(false);
      expect(allowLinkPress('javascript:alert(1)')).toBe(false);
      expect(allowLinkPress('/dashboard')).toBe(false);
    });
  });
});
