import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getCaretLine, getOffsetAtLine } from '../textareaCaret';

/**
 * jsdom lays nothing out, so these tests bring their own layout engine: a
 * monospace grid that wraps at a fixed column, installed over the two offsets
 * the module reads. It is not a browser, but it does reproduce the one property
 * the searches in `textareaCaret` are built on — `top` never decreases as the
 * offset grows, and `left` never decreases within a line — which is what makes
 * their answers checkable at all.
 */
const CHAR_WIDTH = 10;
const LINE_HEIGHT = 20;
const CONTENT_WIDTH = 100;

function positionOf(before: string, charsPerLine: number): { top: number; left: number } {
  let line = 0;
  let column = 0;
  for (const char of before) {
    if (char === '\n') {
      line += 1;
      column = 0;
      continue;
    }
    if (column === charsPerLine) {
      line += 1;
      column = 0;
    }
    column += 1;
  }
  // The marker always holds text, and text at a full column starts the next
  // line — the same place a browser draws the caret at a soft wrap.
  if (column === charsPerLine) {
    line += 1;
    column = 0;
  }
  return { top: line * LINE_HEIGHT, left: column * CHAR_WIDTH };
}

/** The mirror puts everything before the caret in the span's previous sibling. */
function markerPosition(span: HTMLElement): { top: number; left: number } {
  const width = Number.parseFloat(span.parentElement?.style.width ?? '') || 0;
  const charsPerLine = Math.max(1, Math.floor(width / CHAR_WIDTH));
  return positionOf(span.previousSibling?.textContent ?? '', charsPerLine);
}

function fakeLayout(): () => void {
  const originals = {
    offsetTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop'),
    offsetLeft: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft'),
    clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth'),
  };

  Object.defineProperty(HTMLSpanElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLSpanElement) { return markerPosition(this).top; },
  });
  Object.defineProperty(HTMLSpanElement.prototype, 'offsetLeft', {
    configurable: true,
    get(this: HTMLSpanElement) { return markerPosition(this).left; },
  });
  Object.defineProperty(HTMLTextAreaElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return CONTENT_WIDTH; },
  });

  return () => {
    Reflect.deleteProperty(HTMLSpanElement.prototype, 'offsetTop');
    Reflect.deleteProperty(HTMLSpanElement.prototype, 'offsetLeft');
    Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'clientWidth');
    // Nothing on the subclasses should have shadowed these, but a restore that
    // silently changed the base prototypes would leak into every later test.
    expect(Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')).toEqual(originals.offsetTop);
    expect(Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft')).toEqual(originals.offsetLeft);
    expect(Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')).toEqual(originals.clientWidth);
  };
}

function textareaWith(value: string): HTMLTextAreaElement {
  const textarea = document.createElement('textarea');
  textarea.value = value;
  document.body.appendChild(textarea);
  return textarea;
}

// Ten characters to a line: two full lines and a five-character remainder.
const WRAPPED = 'abcdefghijklmnopqrstuvwxy';

describe('textareaCaret', () => {
  describe('with a measurable layout', () => {
    let restore: () => void;

    beforeEach(() => {
      restore = fakeLayout();
    });

    afterEach(() => {
      restore();
      document.body.querySelectorAll('textarea').forEach(el => el.remove());
    });

    describe('getCaretLine', () => {
      it('reports both boundaries for a value that fits on one line', () => {
        const caret = getCaretLine(textareaWith('short'), 2);

        expect(caret).toEqual({ isFirstLine: true, isLastLine: true, x: 20 });
      });

      it('reports only the first boundary on the first line of a wrapped value', () => {
        const caret = getCaretLine(textareaWith(WRAPPED), 5);

        expect(caret).toEqual({ isFirstLine: true, isLastLine: false, x: 50 });
      });

      it('reports neither boundary in the middle of a wrapped value', () => {
        const caret = getCaretLine(textareaWith(WRAPPED), 15);

        expect(caret).toEqual({ isFirstLine: false, isLastLine: false, x: 50 });
      });

      it('reports only the last boundary on the last line of a wrapped value', () => {
        const caret = getCaretLine(textareaWith(WRAPPED), 23);

        expect(caret).toEqual({ isFirstLine: false, isLastLine: true, x: 30 });
      });

      it('treats a hard newline as a line break like a soft wrap', () => {
        const textarea = textareaWith('ab\ncd');

        expect(getCaretLine(textarea, 2)).toMatchObject({ isFirstLine: true, isLastLine: false });
        expect(getCaretLine(textarea, 3)).toMatchObject({ isFirstLine: false, isLastLine: true });
      });

      it('counts the empty line a trailing newline opens', () => {
        const textarea = textareaWith('ab\n');

        // The caret can still go down from the end of `ab` — onto the blank
        // line below it, which has no characters to measure of its own.
        expect(getCaretLine(textarea, 2)).toMatchObject({ isLastLine: false });
        expect(getCaretLine(textarea, 3)).toMatchObject({ isLastLine: true });
      });
    });

    describe('getOffsetAtLine', () => {
      it('finds the offset at a horizontal position on the first line', () => {
        expect(getOffsetAtLine(textareaWith(WRAPPED), 'first', 30)).toBe(3);
      });

      it('finds the offset at a horizontal position on the last line', () => {
        // The last line starts at offset 20, so 30px along it is offset 23.
        expect(getOffsetAtLine(textareaWith(WRAPPED), 'last', 30)).toBe(23);
      });

      it('rounds to the nearer of the two characters a position falls between', () => {
        const textarea = textareaWith(WRAPPED);

        expect(getOffsetAtLine(textarea, 'first', 34)).toBe(3);
        expect(getOffsetAtLine(textarea, 'first', 36)).toBe(4);
      });

      it('clamps to the end of the line when the position runs past it', () => {
        const textarea = textareaWith(WRAPPED);

        expect(getOffsetAtLine(textarea, 'first', 999)).toBe(9);
        expect(getOffsetAtLine(textarea, 'last', 999)).toBe(25);
      });

      it('clamps to the start of the line when the position is before it', () => {
        expect(getOffsetAtLine(textareaWith(WRAPPED), 'last', 0)).toBe(20);
      });

      it('keeps the column across a hard newline', () => {
        const textarea = textareaWith('abcd\nefgh');

        expect(getOffsetAtLine(textarea, 'first', 20)).toBe(2);
        expect(getOffsetAtLine(textarea, 'last', 20)).toBe(7);
      });

      it('returns 0 for an empty value', () => {
        expect(getOffsetAtLine(textareaWith(''), 'first', 50)).toBe(0);
      });
    });
  });

  describe('without a layout engine', () => {
    afterEach(() => {
      document.body.querySelectorAll('textarea').forEach(el => el.remove());
    });

    it('reports a single line, so arrow keys behave as they do in a one-line field', () => {
      expect(getCaretLine(textareaWith(WRAPPED), 12)).toEqual({
        isFirstLine: true,
        isLastLine: true,
        x: 0,
      });
    });

    it('declines to guess an offset rather than returning the first one', () => {
      expect(getOffsetAtLine(textareaWith(WRAPPED), 'first', 30)).toBeNull();
    });
  });
});
