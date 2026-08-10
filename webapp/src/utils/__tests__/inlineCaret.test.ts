import { describe, it, expect } from 'vitest';
import { renderedOffsetOf, sourceOffsetAtPoint } from '../inlineCaret';
import { renderInlineItem } from '../markdown';

// Only the DOM-position half is testable here: jsdom has no layout, so it
// implements neither caretPositionFromPoint nor caretRangeFromPoint and there
// is no point to resolve. The point-to-position half is exercised for real in
// webapp/e2e/tests/markdown.spec.ts.

/** A container holding the rendered form of `text`, as the row renders it. */
function renderedContainer(text: string): HTMLElement {
  const span = document.createElement('span');
  span.innerHTML = renderInlineItem(text, { links: false }).html;
  document.body.appendChild(span);
  return span;
}

/** The text node at `index` in document order within `container`. */
function textNodeAt(container: HTMLElement, index: number): Text {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let found: Node | null = walker.nextNode();
  for (let i = 0; i < index; i++) found = walker.nextNode();
  if (!found) throw new Error(`no text node at index ${index}`);
  return found as Text;
}

describe('renderedOffsetOf', () => {
  it('counts the text before a position in a later element', () => {
    // "buy <strong>milk</strong>" — the m of milk is the 5th character shown.
    const container = renderedContainer('buy **milk**');
    expect(renderedOffsetOf(container, textNodeAt(container, 1), 0)).toBe(4);
    expect(renderedOffsetOf(container, textNodeAt(container, 1), 2)).toBe(6);
  });

  it('counts a line break as one character', () => {
    // A <br> contributes no text node, so a walk that only counted text would
    // put everything after the break one short — and inlineSourceOffset counts
    // the br node as one, so the two would disagree.
    const container = renderedContainer('a\nb');
    expect(container.innerHTML).toBe('a<br>b');
    expect(renderedOffsetOf(container, textNodeAt(container, 1), 0)).toBe(2);
  });

  it('resolves an element position against its children, not as a total', () => {
    // The browser returns an element position when the point falls between
    // children. `buy <strong>milk</strong>` has two, so offset 1 is the gap
    // before the <strong> — 4 characters in, not the 8 of the whole container.
    const container = renderedContainer('buy **milk**');
    expect(renderedOffsetOf(container, container, 0)).toBe(0);
    expect(renderedOffsetOf(container, container, 1)).toBe(4);
    // Past the last child: everything precedes it. This is the common one, a
    // click past the end of the line.
    expect(renderedOffsetOf(container, container, 2)).toBe(8);
  });

  it('resolves an element position inside a nested element', () => {
    const container = renderedContainer('buy **milk** today');
    const strong = container.querySelector('strong')!;
    expect(renderedOffsetOf(container, strong, 0)).toBe(4);
    expect(renderedOffsetOf(container, strong, 1)).toBe(8);
  });

  it('rejects a node from outside the container', () => {
    const container = renderedContainer('buy **milk**');
    const stray = document.createElement('span');
    expect(renderedOffsetOf(container, stray, 0)).toBeNull();
  });
});

describe('sourceOffsetAtPoint', () => {
  it('falls back to the end of the source when the browser cannot resolve a point', () => {
    // jsdom implements neither caret API, which is the same position a browser
    // that fails to resolve the point leaves us in: no worse than a swap with
    // no mapping at all.
    const text = 'buy **milk**';
    const { nodes } = renderInlineItem(text, { links: false });
    expect(sourceOffsetAtPoint(renderedContainer(text), nodes, text, 10, 10)).toBe(text.length);
  });
});
