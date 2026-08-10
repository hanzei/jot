import {
  renderedInlineText,
  renderedOffsetAtPoint,
  sourceOffsetAtPoint,
  type RenderedTextLine,
} from '../src/utils/inlineCaret';
import { inlineMarkdownNodes } from '../src/utils/inlineMarkdown';

// The half of tap-to-caret that can be tested without a layout engine: given
// where the platform says the lines landed, which character did the user point
// at, and where is it in the source. The other half — the lines themselves —
// only exists on a device.

/** A single line of text, 10px per character on a 20px baseline grid. */
function line(text: string, row = 0): RenderedTextLine {
  return { x: 0, y: row * 20, width: text.length * 10, height: 20, text };
}

describe('renderedInlineText', () => {
  it('is the visible text, with a break rendered as the newline mobile draws', () => {
    expect(renderedInlineText(inlineMarkdownNodes('buy **milk**'))).toBe('buy milk');
    expect(renderedInlineText(inlineMarkdownNodes('a\nb'))).toBe('a\nb');
    expect(renderedInlineText(inlineMarkdownNodes('run `npm ci`'))).toBe('run npm ci');
    expect(renderedInlineText(inlineMarkdownNodes('then *go* now'))).toBe('then go now');
  });
});

describe('renderedOffsetAtPoint', () => {
  it('interpolates across the tapped line', () => {
    const lines = [line('buy milk')];

    expect(renderedOffsetAtPoint('buy milk', lines, 0, 10)).toBe(0);
    expect(renderedOffsetAtPoint('buy milk', lines, 40, 10)).toBe(4);
    expect(renderedOffsetAtPoint('buy milk', lines, 80, 10)).toBe(8);
  });

  it('clamps a tap outside the line box to its ends', () => {
    const lines = [line('buy milk')];

    expect(renderedOffsetAtPoint('buy milk', lines, -50, 10)).toBe(0);
    expect(renderedOffsetAtPoint('buy milk', lines, 500, 10)).toBe(8);
  });

  it('picks the line the tap falls on, and the nearest one outside them all', () => {
    const rendered = 'buy some milk';
    const lines = [line('buy some ', 0), line('milk', 1)];

    expect(renderedOffsetAtPoint(rendered, lines, 0, 5)).toBe(0);
    expect(renderedOffsetAtPoint(rendered, lines, 0, 25)).toBe(9);
    // Above the first line and below the last: a tap anywhere in the row means
    // the row, so both clamp rather than miss.
    expect(renderedOffsetAtPoint(rendered, lines, 20, -30)).toBe(2);
    expect(renderedOffsetAtPoint(rendered, lines, 40, 300)).toBe(13);
  });

  it('counts a hard line break, whether or not the platform reports it', () => {
    // Android hands back the newline at the end of the line it broke; iOS does
    // not. Either way the offset of the second line has to be past it.
    const rendered = 'first\nsecond';
    const withNewline = [line('first\n', 0), line('second', 1)];
    const withoutNewline = [line('first', 0), line('second', 1)];

    expect(renderedOffsetAtPoint(rendered, withNewline, 0, 25)).toBe(6);
    expect(renderedOffsetAtPoint(rendered, withoutNewline, 0, 25)).toBe(6);
  });

  it('falls back to the end when nothing has been measured', () => {
    expect(renderedOffsetAtPoint('buy milk', [], 10, 10)).toBe(8);
  });
});

describe('sourceOffsetAtPoint', () => {
  it('maps a tap on rendered text to the same character in the source', () => {
    const source = 'buy **milk**';
    const nodes = inlineMarkdownNodes(source);
    const lines = [line('buy milk')];

    // Character 4 of `buy milk` is the `m`, which sits at 6 in the source.
    expect(sourceOffsetAtPoint(nodes, source, lines, 40, 10)).toBe(6);
    expect(sourceOffsetAtPoint(nodes, source, lines, 0, 10)).toBe(0);
  });

  it('maps through a second line', () => {
    const source = 'buy some **milk**';
    const nodes = inlineMarkdownNodes(source);
    const lines = [line('buy some ', 0), line('milk', 1)];

    expect(sourceOffsetAtPoint(nodes, source, lines, 0, 25)).toBe(11);
  });

  it('puts the caret at the end when the text has not been measured yet', () => {
    const source = 'buy **milk**';

    expect(sourceOffsetAtPoint(inlineMarkdownNodes(source), source, null, 40, 10)).toBe(source.length);
    expect(sourceOffsetAtPoint(inlineMarkdownNodes(source), source, [], 40, 10)).toBe(source.length);
  });
});
