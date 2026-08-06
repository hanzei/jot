import React from 'react';
import { Platform } from 'react-native';
import { render } from '@testing-library/react-native';
import { MARKDOWN_ITEM_CASES } from '@jot/shared';
import InlineMarkdown from '../src/components/InlineMarkdown';

// The mobile half of the shared item corpus (shared/src/markdownCases.ts);
// webapp/src/utils/__tests__/inlineMarkdown.test.ts runs the same list through
// marked's HTML output. The coverage test at the bottom keeps the two in step.
//
// Both clients lex with marked and normalize through shared/src/inlineMarkdown.ts,
// so what is under test here is the React Native leaf rendering: which nodes the
// user can read, which ones they can tap, and which carry emphasis styling.

type RenderedNode = { props?: Record<string, unknown>; children?: unknown[] } | string | null;

function renderCase(id: string): RenderedNode {
  const testCase = MARKDOWN_ITEM_CASES.find((c) => c.id === id);
  if (!testCase) throw new Error(`unknown markdown item case: ${id}`);
  return render(<InlineMarkdown text={testCase.markdown} />).toJSON() as RenderedNode;
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
  return own.concat((node.children ?? []).flatMap((child) => tappableText(child as RenderedNode)));
}

function flattenStyle(style: unknown): Record<string, unknown>[] {
  if (Array.isArray(style)) return style.flatMap(flattenStyle);
  if (style && typeof style === 'object') return [style as Record<string, unknown>];
  return [];
}

/** The text of every node whose style sets `property` to `value`. */
function styledText(node: RenderedNode, property: string, value: unknown): string[] {
  if (node === null || typeof node === 'string') return [];
  const matches = flattenStyle(node.props?.style).some((s) => s[property] === value);
  const own = matches ? [visibleText(node)] : [];
  return own.concat(
    (node.children ?? []).flatMap((child) => styledText(child as RenderedNode, property, value)),
  );
}

const bold = (id: string) => styledText(renderCase(id), 'fontWeight', '700');
const italic = (id: string) => styledText(renderCase(id), 'fontStyle', 'italic');
const struck = (id: string) => styledText(renderCase(id), 'textDecorationLine', 'line-through');
const text = (id: string) => visibleText(renderCase(id));
const tappable = (id: string) => tappableText(renderCase(id));

const conformance: Record<string, () => void> = {
  'item-bold': () => {
    expect(text('item-bold')).toBe('buy milk');
    expect(bold('item-bold')).toContain('milk');
  },
  'item-italic': () => {
    expect(text('item-italic')).toBe('buy milk');
    expect(italic('item-italic')).toContain('milk');
  },
  'item-strike': () => {
    expect(text('item-strike')).toBe('buy milk');
    expect(struck('item-strike')).toContain('milk');
  },
  'item-code': () => {
    expect(text('item-code')).toBe('run npm ci');
    // Monospace is the whole of the code styling on mobile — see the note in
    // InlineMarkdown's stylesheet about why there is no background tint. The
    // face is platform-specific, so the expectation resolves the same way the
    // component does rather than pinning one platform's name.
    const monospace = Platform.select({ ios: 'Menlo', default: 'monospace' });
    expect(styledText(renderCase('item-code'), 'fontFamily', monospace)).toContain('npm ci');
  },
  'item-nested-emphasis': () => {
    expect(text('item-nested-emphasis')).toBe('bold and italic');
    expect(bold('item-nested-emphasis')).toContain('bold and italic');
    expect(italic('item-nested-emphasis')).toContain('and italic');
  },

  'item-link': () => {
    expect(text('item-link')).toBe('docs');
    expect(tappable('item-link')).toEqual(['docs']);
  },
  'item-link-formatted-label': () => {
    expect(tappable('item-link-formatted-label')).toEqual(['docs']);
    expect(bold('item-link-formatted-label')).toContain('docs');
  },
  'item-bare-url': () => {
    expect(text('item-bare-url')).toBe('see https://example.com');
    expect(tappable('item-bare-url')).toEqual(['https://example.com']);
  },
  'item-bare-url-www': () => {
    expect(text('item-bare-url-www')).toBe('see www.example.com');
    expect(tappable('item-bare-url-www')).toEqual(['www.example.com']);
  },
  'item-bare-domain': () => {
    expect(text('item-bare-domain')).toBe('see example.com');
    expect(tappable('item-bare-domain')).toEqual([]);
  },
  'item-mailto': () => expect(tappable('item-mailto')).toEqual(['mail']),
  'item-tel-link': () => {
    expect(text('item-tel-link')).toBe('call');
    expect(tappable('item-tel-link')).toEqual([]);
  },
  'item-javascript-link': () => {
    expect(text('item-javascript-link')).toBe('click');
    expect(tappable('item-javascript-link')).toEqual([]);
  },
  'item-relative-link': () => {
    expect(text('item-relative-link')).toBe('rel');
    expect(tappable('item-relative-link')).toEqual([]);
  },
  'item-empty-link-label': () => {
    // Never an invisible tappable region: the target becomes its own label.
    expect(text('item-empty-link-label')).toBe('https://example.com');
    expect(tappable('item-empty-link-label')).toEqual(['https://example.com']);
  },

  // Block syntax stays literal because items are lexed as inline content.
  'item-heading-literal': () => {
    expect(text('item-heading-literal')).toBe('# not a heading');
    expect(bold('item-heading-literal')).toEqual([]);
  },
  'item-bullet-literal': () => expect(text('item-bullet-literal')).toBe('- not a bullet'),
  'item-ordered-literal': () => expect(text('item-ordered-literal')).toBe('1. not a list'),
  'item-task-literal': () => {
    expect(text('item-task-literal')).toBe('- [ ] not a checkbox');
    expect(text('item-task-literal')).not.toContain('☐');
  },
  'item-hr-literal': () => expect(text('item-hr-literal')).toBe('---'),
  'item-blockquote-literal': () => expect(text('item-blockquote-literal')).toBe('> not a quote'),
  'item-table-literal': () => expect(text('item-table-literal')).toBe('a | b'),

  'item-image': () => {
    expect(text('item-image')).toBe('see ![alt](https://example.com/y.png)');
    expect(tappable('item-image')).toEqual([]);
  },
  'item-raw-html': () => expect(text('item-raw-html')).toBe('<b>bold</b> text'),
  'item-raw-html-script': () =>
    expect(text('item-raw-html-script')).toBe('<script>alert(1)</script>'),

  'item-escaped-star': () => {
    expect(text('item-escaped-star')).toBe('*not emphasis*');
    expect(italic('item-escaped-star')).toEqual([]);
  },
  'item-arithmetic': () => {
    expect(text('item-arithmetic')).toBe('2 * 3 * 4');
    expect(italic('item-arithmetic')).toEqual([]);
  },
  'item-underscored-word': () => {
    expect(text('item-underscored-word')).toBe('my_file_name.txt');
    expect(italic('item-underscored-word')).toEqual([]);
  },
  'item-ampersand': () => expect(text('item-ampersand')).toBe('salt & pepper < 5'),
  'item-plain': () => expect(text('item-plain')).toBe('milk'),
};

describe('InlineMarkdown', () => {
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
      conformance[testCase.id]!();
    });
  }

  it('renders a newline for a line break', () => {
    expect(visibleText(render(<InlineMarkdown text={'a\nb'} />).toJSON() as RenderedNode)).toBe(
      'a\nb',
    );
  });

  it('renders empty text without crashing', () => {
    expect(visibleText(render(<InlineMarkdown text="" />).toJSON() as RenderedNode)).toBe('');
  });
});
