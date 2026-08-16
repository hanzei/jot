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

async function renderCase(id: string): Promise<RenderedNode> {
  const testCase = MARKDOWN_ITEM_CASES.find((c) => c.id === id);
  if (!testCase) throw new Error(`unknown markdown item case: ${id}`);
  return (await render(<InlineMarkdown text={testCase.markdown} />)).toJSON() as RenderedNode;
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

const bold = async (id: string) => styledText(await renderCase(id), 'fontWeight', '700');
const italic = async (id: string) => styledText(await renderCase(id), 'fontStyle', 'italic');
const struck = async (id: string) => styledText(await renderCase(id), 'textDecorationLine', 'line-through');
const text = async (id: string) => visibleText(await renderCase(id));
const tappable = async (id: string) => tappableText(await renderCase(id));

const conformance: Record<string, () => Promise<void>> = {
  'item-bold': async () => {
    expect(await text('item-bold')).toBe('buy milk');
    expect(await bold('item-bold')).toContain('milk');
  },
  'item-italic': async () => {
    expect(await text('item-italic')).toBe('buy milk');
    expect(await italic('item-italic')).toContain('milk');
  },
  'item-strike': async () => {
    expect(await text('item-strike')).toBe('buy milk');
    expect(await struck('item-strike')).toContain('milk');
  },
  'item-code': async () => {
    expect(await text('item-code')).toBe('run npm ci');
    // Monospace is the whole of the code styling on mobile — see the note in
    // InlineMarkdown's stylesheet about why there is no background tint. The
    // face is platform-specific, so the expectation resolves the same way the
    // component does rather than pinning one platform's name.
    const monospace = Platform.select({ ios: 'Menlo', default: 'monospace' });
    expect(styledText(await renderCase('item-code'), 'fontFamily', monospace)).toContain('npm ci');
  },
  'item-nested-emphasis': async () => {
    expect(await text('item-nested-emphasis')).toBe('bold and italic');
    expect(await bold('item-nested-emphasis')).toContain('bold and italic');
    expect(await italic('item-nested-emphasis')).toContain('and italic');
  },

  'item-link': async () => {
    expect(await text('item-link')).toBe('docs');
    expect(await tappable('item-link')).toEqual(['docs']);
  },
  'item-link-formatted-label': async () => {
    expect(await tappable('item-link-formatted-label')).toEqual(['docs']);
    expect(await bold('item-link-formatted-label')).toContain('docs');
  },
  'item-bare-url': async () => {
    expect(await text('item-bare-url')).toBe('see https://example.com');
    expect(await tappable('item-bare-url')).toEqual(['https://example.com']);
  },
  'item-bare-url-www': async () => {
    expect(await text('item-bare-url-www')).toBe('see www.example.com');
    expect(await tappable('item-bare-url-www')).toEqual(['www.example.com']);
  },
  'item-bare-domain': async () => {
    expect(await text('item-bare-domain')).toBe('see example.com');
    expect(await tappable('item-bare-domain')).toEqual([]);
  },
  'item-mailto': async () => expect(await tappable('item-mailto')).toEqual(['mail']),
  'item-tel-link': async () => {
    expect(await text('item-tel-link')).toBe('call');
    expect(await tappable('item-tel-link')).toEqual([]);
  },
  'item-javascript-link': async () => {
    expect(await text('item-javascript-link')).toBe('click');
    expect(await tappable('item-javascript-link')).toEqual([]);
  },
  'item-relative-link': async () => {
    expect(await text('item-relative-link')).toBe('rel');
    expect(await tappable('item-relative-link')).toEqual([]);
  },
  'item-empty-link-label': async () => {
    // Never an invisible tappable region: the target becomes its own label.
    expect(await text('item-empty-link-label')).toBe('https://example.com');
    expect(await tappable('item-empty-link-label')).toEqual(['https://example.com']);
  },

  // Block syntax stays literal because items are lexed as inline content.
  'item-heading-literal': async () => {
    expect(await text('item-heading-literal')).toBe('# not a heading');
    expect(await bold('item-heading-literal')).toEqual([]);
  },
  'item-bullet-literal': async () => expect(await text('item-bullet-literal')).toBe('- not a bullet'),
  'item-ordered-literal': async () => expect(await text('item-ordered-literal')).toBe('1. not a list'),
  'item-task-literal': async () => {
    expect(await text('item-task-literal')).toBe('- [ ] not a checkbox');
    expect(await text('item-task-literal')).not.toContain('☐');
  },
  'item-hr-literal': async () => expect(await text('item-hr-literal')).toBe('---'),
  'item-blockquote-literal': async () => expect(await text('item-blockquote-literal')).toBe('> not a quote'),
  'item-table-literal': async () => expect(await text('item-table-literal')).toBe('a | b'),

  'item-image': async () => {
    expect(await text('item-image')).toBe('see ![alt](https://example.com/y.png)');
    expect(await tappable('item-image')).toEqual([]);
  },
  'item-raw-html': async () => expect(await text('item-raw-html')).toBe('<b>bold</b> text'),
  'item-raw-html-script': async () =>
    expect(await text('item-raw-html-script')).toBe('<script>alert(1)</script>'),

  'item-escaped-star': async () => {
    expect(await text('item-escaped-star')).toBe('*not emphasis*');
    expect(await italic('item-escaped-star')).toEqual([]);
  },
  'item-arithmetic': async () => {
    expect(await text('item-arithmetic')).toBe('2 * 3 * 4');
    expect(await italic('item-arithmetic')).toEqual([]);
  },
  'item-underscored-word': async () => {
    expect(await text('item-underscored-word')).toBe('my_file_name.txt');
    expect(await italic('item-underscored-word')).toEqual([]);
  },
  'item-ampersand': async () => expect(await text('item-ampersand')).toBe('salt & pepper < 5'),
  'item-plain': async () => expect(await text('item-plain')).toBe('milk'),
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
    it(`${testCase.id}: ${testCase.expected}`, async () => {
      await conformance[testCase.id]!();
    });
  }

  it('renders a newline for a line break', async () => {
    expect(visibleText((await render(<InlineMarkdown text={'a\nb'} />)).toJSON() as RenderedNode)).toBe(
      'a\nb',
    );
  });

  it('renders empty text without crashing', async () => {
    expect(visibleText((await render(<InlineMarkdown text="" />)).toJSON() as RenderedNode)).toBe('');
  });
});
