import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { MARKDOWN_CASES } from '@jot/shared';
import Markdown from '../src/components/Markdown';
import MarkdownPreview, { PREVIEW_LINES } from '../src/components/MarkdownPreview';
import { compactMarkdownStyles, fullMarkdownStyles } from '../src/utils/markdownStyles';

// The mobile half of the shared conformance corpus (shared/src/markdownCases.ts);
// webapp/src/utils/__tests__/markdown.test.ts runs the same list through marked's
// HTML renderer. The coverage test at the bottom is what keeps the two from
// drifting apart.
//
// Everything is asserted against the rendered React Native tree — what the user
// actually sees — rather than against the parser. Both clients lex with marked
// now, so a token-level assertion would mostly re-test marked; the interesting
// half is what this app does with the tokens.

function markdownFor(id: string): string {
  const testCase = MARKDOWN_CASES.find((c) => c.id === id);
  if (!testCase) throw new Error(`unknown markdown case: ${id}`);
  return testCase.markdown;
}

type RenderedNode =
  | { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  | string
  | null;

function renderCase(id: string): RenderedNode {
  return render(<Markdown content={markdownFor(id)} />).toJSON() as RenderedNode;
}

function renderPreview(id: string): RenderedNode {
  return render(<MarkdownPreview content={markdownFor(id)} />).toJSON() as RenderedNode;
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

/**
 * The effective style of the innermost node whose whole visible text is `text`.
 *
 * Styles are merged down the path to it, because that is how nested <Text>
 * behaves on React Native: a child inherits the font of every Text above it, so
 * the merged style is what the glyphs are actually drawn with.
 */
function styleOf(
  node: RenderedNode,
  text: string,
  inherited: Record<string, unknown> = {},
): Record<string, unknown> | null {
  if (node === null || typeof node === 'string') return null;
  const own = (StyleSheet.flatten(node.props?.style as never) ?? {}) as Record<string, unknown>;
  const merged = { ...inherited, ...own };

  for (const child of node.children ?? []) {
    const found = styleOf(child as RenderedNode, text, merged);
    if (found) return found;
  }

  return visibleText(node) === text ? merged : null;
}

function styleFor(node: RenderedNode, text: string): Record<string, unknown> {
  const style = styleOf(node, text);
  if (!style) throw new Error(`no rendered node reads exactly ${JSON.stringify(text)}`);
  return style;
}

/** Views matching a predicate on their style — the block boxes a Text cannot draw. */
function boxes(
  node: RenderedNode,
  match: (style: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  if (node === null || typeof node === 'string') return [];
  const style = (StyleSheet.flatten(node.props?.style as never) ?? {}) as Record<string, unknown>;
  const own = node.type === 'View' && match(style) ? [style] : [];
  return own.concat(
    (node.children ?? []).flatMap((child) => boxes(child as RenderedNode, match)),
  );
}

const hasTint = (node: RenderedNode) => boxes(node, (s) => s.backgroundColor !== undefined).length;
const hasBar = (node: RenderedNode) => boxes(node, (s) => Number(s.borderLeftWidth) > 0).length;
const hasRule = (node: RenderedNode) => boxes(node, (s) => s.height === 1).length;

const conformance: Record<string, () => void> = {
  bold: () => expect(styleFor(renderCase('bold'), 'hello').fontWeight).toBe('700'),
  italic: () => expect(styleFor(renderCase('italic'), 'hello').fontStyle).toBe('italic'),
  strikethrough: () =>
    expect(styleFor(renderCase('strikethrough'), 'hello').textDecorationLine).toBe('line-through'),

  'heading-1': () =>
    expect(styleFor(renderCase('heading-1'), 'Top heading').fontSize).toBe(
      fullMarkdownStyles.heading1.fontSize,
    ),
  'heading-3': () =>
    expect(styleFor(renderCase('heading-3'), 'Third heading').fontSize).toBe(
      fullMarkdownStyles.heading3.fontSize,
    ),
  // h4-h6 keep their depth and are styled down, so they carry body size in bold
  // rather than a size of their own.
  'heading-4-bold': () => {
    const style = styleFor(renderCase('heading-4-bold'), 'Fourth heading');
    expect(style.fontSize).toBe(fullMarkdownStyles.body.fontSize);
    expect(style.fontWeight).toBe('700');
  },
  'heading-6-bold': () => {
    const style = styleFor(renderCase('heading-6-bold'), 'Sixth heading');
    expect(style.fontSize).toBe(fullMarkdownStyles.body.fontSize);
    expect(style.fontWeight).toBe('700');
  },

  'inline-code': () => expect(styleFor(renderCase('inline-code'), 'code').fontFamily).toBeTruthy(),
  'fenced-code': () => {
    const tree = renderCase('fenced-code');
    expect(styleFor(tree, 'const a = 1;').fontFamily).toBeTruthy();
    // Block layout: the tinted box a fenced block sits in, which inline code has
    // no equivalent of.
    expect(hasTint(tree)).toBe(1);
  },
  'indented-code': () => {
    const tree = renderCase('indented-code');
    expect(styleFor(tree, 'indented code').fontFamily).toBeTruthy();
    expect(hasTint(tree)).toBe(1);
  },
  'task-marker-in-code': () => {
    const tree = renderCase('task-marker-in-code');
    expect(visibleText(tree)).toBe('- [x] not a checkbox');
    expect(hasTint(tree)).toBe(1);
  },

  'bullet-list': () => expect(visibleText(renderCase('bullet-list'))).toBe('•item'),
  'ordered-list': () => expect(visibleText(renderCase('ordered-list'))).toBe('1.item'),
  'task-unchecked': () => expect(visibleText(renderCase('task-unchecked'))).toContain('☐ todo'),
  'task-checked': () => expect(visibleText(renderCase('task-checked'))).toContain('☑ done'),
  'task-checked-uppercase': () =>
    expect(visibleText(renderCase('task-checked-uppercase'))).toContain('☑ done'),
  'task-marker-outside-list': () => {
    const tree = renderCase('task-marker-outside-list');
    expect(visibleText(tree)).toBe('[x] not a task');
    expect(visibleText(tree)).not.toContain('☑');
  },

  blockquote: () => {
    const tree = renderCase('blockquote');
    expect(visibleText(tree)).toBe('quote');
    expect(hasBar(tree)).toBe(1);
  },
  'hr-dashes': () => expect(hasRule(renderCase('hr-dashes'))).toBe(1),
  'hr-stars': () => expect(hasRule(renderCase('hr-stars'))).toBe(1),

  'inline-link': () => expect(tappableText(renderCase('inline-link'))).toEqual(['text']),
  'bare-url': () => expect(tappableText(renderCase('bare-url'))).toEqual(['https://example.com']),
  'bare-url-www': () =>
    expect(tappableText(renderCase('bare-url-www'))).toEqual(['www.example.com']),
  'bare-domain': () => {
    const tree = renderCase('bare-domain');
    expect(visibleText(tree)).toBe('visit example.com now');
    expect(tappableText(tree)).toEqual([]);
  },
  'mailto-link': () => expect(tappableText(renderCase('mailto-link'))).toEqual(['mail']),
  'tel-link': () => {
    const tree = renderCase('tel-link');
    expect(visibleText(tree)).toBe('call');
    expect(tappableText(tree)).toEqual([]);
  },
  'javascript-link': () => expect(tappableText(renderCase('javascript-link'))).toEqual([]),
  'relative-link': () => {
    const tree = renderCase('relative-link');
    expect(visibleText(tree)).toBe('rel');
    expect(tappableText(tree)).toEqual([]);
  },

  image: () => {
    const tree = renderCase('image');
    expect(visibleText(tree)).toBe('![alt text](https://example.com/y.png)');
    expect(tappableText(tree)).toEqual([]);
  },
  'image-with-title': () =>
    expect(visibleText(renderCase('image-with-title'))).toBe(
      '![alt](https://example.com/y.png "the title")',
    ),
  'image-empty-alt': () => {
    const tree = renderCase('image-empty-alt');
    expect(visibleText(tree)).toBe('![](https://example.com/y.png)');
    expect(tappableText(tree)).toEqual([]);
  },
  'image-inline-in-paragraph': () =>
    expect(visibleText(renderCase('image-inline-in-paragraph'))).toBe(
      'see ![a](https://example.com/y.png) here',
    ),

  table: () => expect(visibleText(renderCase('table'))).toBe('a | b\n--- | ---\n1 | 2'),
  'table-cell-url': () => {
    const tree = renderCase('table-cell-url');
    expect(visibleText(tree)).toBe('a | b\n--- | ---\nhttps://example.com | 2');
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
      conformance[testCase.id]!();
    });
  }

  describe('block layout', () => {
    /** Every ancestor chain that puts a View inside a Text. */
    function viewsInsideText(node: RenderedNode, insideText = false, path: string[] = []): string[] {
      if (node === null || typeof node === 'string') return [];
      const here = [...path, node.type ?? '?'];
      const own = insideText && node.type === 'View' ? [here.join(' > ')] : [];
      return own.concat(
        (node.children ?? []).flatMap((child) =>
          viewsInsideText(child as RenderedNode, insideText || node.type === 'Text', here),
        ),
      );
    }

    // Nesting a View inside a Text breaks text wrapping on React Native. The
    // structural rule that avoids it — blocks own Views, the inline level is all
    // Text — is invisible in a diff, so it is asserted on the construct that
    // breaks a naive recursive renderer first.
    it('never nests a View inside a Text', () => {
      const nested = '> quoted\n>\n> - one\n> - two\n>\n> ```\n> code\n> ```';
      const tree = render(<Markdown content={nested} />).toJSON() as RenderedNode;

      expect(viewsInsideText(tree)).toEqual([]);
      expect(visibleText(tree)).toBe('quoted•one•twocode');
    });
  });

  describe('heading semantics', () => {
    /** Nodes carrying the native header role. */
    function headers(node: RenderedNode): string[] {
      if (node === null || typeof node === 'string') return [];
      const own = node.props?.accessibilityRole === 'header' ? [visibleText(node)] : [];
      return own.concat(
        (node.children ?? []).flatMap((child) => headers(child as RenderedNode)),
      );
    }

    it('marks every heading depth as a header for assistive technology', () => {
      // All six, because the depths do not share a code path: h1-h3 carry their
      // own size, h4-h6 fall through to body size, and the role has to survive
      // both. `body` is the control — a paragraph is not a header.
      const markdown = ['# one', '## two', '### three', '#### four', '##### five', '###### six', 'body']
        .join('\n\n');
      const tree = render(<Markdown content={markdown} />).toJSON() as RenderedNode;

      expect(headers(tree)).toEqual(['one', 'two', 'three', 'four', 'five', 'six']);
    });

    // The card is one clamped Text inside a control that opens the note, so an
    // outline inside it would be noise rather than structure.
    it('sets no header role in the card preview', () => {
      const tree = render(<MarkdownPreview content="# one" />).toJSON() as RenderedNode;
      expect(headers(tree)).toEqual([]);
    });
  });

  describe('heading styles', () => {
    it('renders h4-h6 at body size in bold, not as their own heading sizes', () => {
      for (const styles of [fullMarkdownStyles, compactMarkdownStyles]) {
        for (const level of ['heading4', 'heading5', 'heading6'] as const) {
          expect(styles[level].fontSize).toBe(styles.body.fontSize);
          expect(styles[level].fontWeight).toBe('700');
        }
      }
    });
  });
});

// The note card renders the same blocks as one clamped <Text> (#819). It is a
// different layout of the same content, never a different feature set, so the
// parity test below is the real assertion and the cases after it only pin the
// affordances a Text has to substitute for a box.
describe('markdown card preview', () => {
  /**
   * Visible text with whitespace and the rule stand-in removed.
   *
   * The two renderers lay blocks out differently — a marker column versus a
   * "• " prefix, a rule View versus a run of dashes — so their text differs by
   * exactly that much and by nothing else.
   */
  function content(node: RenderedNode): string {
    return visibleText(node).replace(/[─\s]/g, '');
  }

  it('shows the same content as the editor for every conformance case', () => {
    for (const testCase of MARKDOWN_CASES) {
      expect(content(renderPreview(testCase.id))).toBe(content(renderCase(testCase.id)));
    }
  });

  it('clamps to six lines however long the note is', () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n\n');
    const tree = render(<MarkdownPreview content={long} />).toJSON() as RenderedNode;
    expect((tree as { props: Record<string, unknown> }).props.numberOfLines).toBe(PREVIEW_LINES);
    expect(PREVIEW_LINES).toBe(6);
  });

  it('renders nothing for an empty note', () => {
    expect(render(<MarkdownPreview content="   " />).toJSON()).toBeNull();
  });

  it('gives list items a marker and nested items an indent', () => {
    const tree = render(<MarkdownPreview content={'- a\n  - b\n- [x] c'} />).toJSON() as RenderedNode;
    expect(visibleText(tree)).toBe('• a\n  • b\n• ☑ c');
  });

  it('numbers ordered items from the list start', () => {
    const tree = render(<MarkdownPreview content={'3. a\n4. b'} />).toJSON() as RenderedNode;
    expect(visibleText(tree)).toBe('3. a\n4. b');
  });

  it('stands a horizontal rule in for the one it cannot draw', () => {
    const tree = render(<MarkdownPreview content={'a\n\n---\n\nb'} />).toJSON() as RenderedNode;
    expect(visibleText(tree)).toMatch(/^a\n─+\nb$/);
  });

  it('carries a blockquote with colour, having no bar to draw', () => {
    const tree = render(<MarkdownPreview content={'> quoted\n\nplain'} />).toJSON() as RenderedNode;
    expect(styleFor(tree, 'quoted').color).not.toBe(styleFor(tree, 'plain').color);
  });

  // A card is one control that opens the note. A link inside it would take the
  // tap instead, so links render as their label — and must not *look* tappable
  // either, since an underline on something inert is the worse failure.
  it('renders links as plain text, with nothing to tap and no underline', () => {
    const tree = render(
      <MarkdownPreview content="see https://example.com and [docs](https://example.org)" />,
    ).toJSON() as RenderedNode;

    expect(visibleText(tree)).toBe('see https://example.com and docs');
    expect(tappableText(tree)).toEqual([]);

    // Not just "no underline": a label left in the link colour would still read
    // as a link. It has to be drawn exactly like the text around it, so the
    // surrounding run is the reference.
    const bodyColor = styleFor(tree, 'see ').color;
    expect(bodyColor).toBeDefined();
    for (const label of ['https://example.com', 'docs']) {
      expect(styleFor(tree, label).textDecorationLine).toBeUndefined();
      expect(styleFor(tree, label).color).toBe(bodyColor);
    }
  });

  it('still renders every other inline construct', () => {
    const tree = render(
      <MarkdownPreview content="**b** *i* ~~s~~ `c`" />,
    ).toJSON() as RenderedNode;

    expect(styleFor(tree, 'b').fontWeight).toBe('700');
    expect(styleFor(tree, 'i').fontStyle).toBe('italic');
    expect(styleFor(tree, 's').textDecorationLine).toBe('line-through');
    expect(styleFor(tree, 'c').fontFamily).toBeTruthy();
  });
});
