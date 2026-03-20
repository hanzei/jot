import {
  applyBold,
  applyBulletList,
  applyCode,
  applyHeading,
  applyHorizontalRule,
  applyItalic,
  applyLink,
  applyOrderedList,
  applyStrikethrough,
} from '@/utils/markdownFormatting';

describe('markdown formatting helpers', () => {
  it.each([
    ['bold with selection', () => applyBold('Hello', { start: 0, end: 5 }), '**Hello**', { start: 2, end: 7 }],
    ['bold without selection', () => applyBold('Hello', { start: 5, end: 5 }), 'Hello****', { start: 7, end: 7 }],
    ['italic with selection', () => applyItalic('Hello', { start: 0, end: 5 }), '*Hello*', { start: 1, end: 6 }],
    ['italic without selection', () => applyItalic('Hello', { start: 5, end: 5 }), 'Hello**', { start: 6, end: 6 }],
    ['strikethrough with selection', () => applyStrikethrough('Hello', { start: 0, end: 5 }), '~~Hello~~', { start: 2, end: 7 }],
    ['strikethrough without selection', () => applyStrikethrough('Hello', { start: 5, end: 5 }), 'Hello~~~~', { start: 7, end: 7 }],
    ['heading with selection', () => applyHeading('Line one\nLine two', { start: 0, end: 17 }, 2), '## Line one\n## Line two', { start: 3, end: 23 }],
    ['heading without selection', () => applyHeading('Line one', { start: 0, end: 0 }, 2), '## Line one', { start: 3, end: 3 }],
    ['bullet list with selection', () => applyBulletList('item one\nitem two', { start: 0, end: 17 }), '- item one\n- item two', { start: 2, end: 21 }],
    ['bullet list without selection', () => applyBulletList('item one', { start: 0, end: 0 }), '- item one', { start: 2, end: 2 }],
    ['ordered list with selection', () => applyOrderedList('item one\nitem two', { start: 0, end: 17 }), '1. item one\n1. item two', { start: 3, end: 23 }],
    ['ordered list without selection', () => applyOrderedList('item one', { start: 0, end: 0 }), '1. item one', { start: 3, end: 3 }],
    ['code with multi-line selection', () => applyCode('line 1\nline 2', { start: 0, end: 13 }), '```\nline 1\nline 2\n```', { start: 4, end: 17 }],
    ['code without selection', () => applyCode('code', { start: 4, end: 4 }), 'code``', { start: 5, end: 5 }],
    ['link with selection', () => applyLink('OpenAI', { start: 0, end: 6 }), '[OpenAI](url)', { start: 9, end: 12 }],
    ['link without selection', () => applyLink('Link', { start: 4, end: 4 }), 'Link[](url)', { start: 5, end: 5 }],
    ['horizontal rule with selection', () => applyHorizontalRule('Top\nBottom', { start: 4, end: 10 }), 'Top\n---\n', { start: 8, end: 8 }],
    ['horizontal rule without selection', () => applyHorizontalRule('Top', { start: 3, end: 3 }), 'Top\n---\n', { start: 8, end: 8 }],
  ])('%s', (_name, runFormat, expectedText, expectedSelection) => {
    const result = runFormat();

    expect(result.text).toBe(expectedText);
    expect(result.selection).toEqual(expectedSelection);
  });

  it('toggles an existing matching heading level off', () => {
    const result = applyHeading('## Existing heading', { start: 0, end: 0 }, 2);

    expect(result.text).toBe('Existing heading');
    expect(result.selection).toEqual({ start: 0, end: 0 });
  });

  it('replaces pasted h5 and h6 headings instead of nesting hashes', () => {
    const result = applyHeading('##### Imported heading', { start: 0, end: 0 }, 2);

    expect(result.text).toBe('## Imported heading');
    expect(result.selection).toEqual({ start: 3, end: 3 });
  });
});
