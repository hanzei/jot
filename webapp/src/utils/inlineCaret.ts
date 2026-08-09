import { inlineSourceOffset, type InlineNode } from '@jot/shared';

/**
 * Turning a click on rendered list-item text into a caret position in the
 * source behind it.
 *
 * The editable row shows rendered Markdown until it is focused, so a click has
 * to answer a question a plain textarea answers for itself: the user pointed at
 * character 4 of `buy milk`, and the field holds `buy **milk**`, where that
 * character is at 6. Without this the caret lands at 0 on every click — which is
 * what the text-note editor does today, and is tolerable there only because it
 * happens once per note rather than once per row.
 *
 * Two halves, kept separate because only one of them can be tested without a
 * layout engine: the browser maps a point to a DOM position, and this module
 * maps that position to an offset in the source.
 */

/**
 * `caretPositionFromPoint` is the standard spelling and `caretRangeFromPoint`
 * the WebKit one. Declared structurally rather than relied on from lib.dom, so
 * that a browser missing both is a plain feature test rather than a type error.
 */
interface CaretPositionSource {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => { startContainer: Node; startOffset: number } | null;
}

/**
 * How many characters of visible text precede (`node`, `offset`) within
 * `container`, or null if that position is not inside it.
 *
 * Counts a `<br>` as one character so the total lines up with what
 * `inlineSourceOffset` counts for a `br` node — the two walks have to agree on
 * what a line break costs or every offset after the first newline is wrong.
 */
export function renderedOffsetOf(container: HTMLElement, node: Node, offset: number): number | null {
  if (!container.contains(node)) return null;

  const walker = container.ownerDocument.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  );

  let consumed = 0;
  for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
    if (current === node) {
      // An element target means the browser pointed at a gap between children
      // rather than into text — past the end of a line, most often. Its offset
      // is a child index, not a character index, so there is nothing to add.
      return current.nodeType === Node.TEXT_NODE ? consumed + offset : consumed;
    }
    if (current.nodeType === Node.TEXT_NODE) {
      consumed += (current as Text).length;
    } else if ((current as Element).tagName === 'BR') {
      consumed += 1;
    }
  }

  // The position is inside `container` but the walk never reached it, which
  // means `node` is the container itself with a child index for an offset.
  return node === container ? consumed : null;
}

/**
 * The offset in `source` that a click at (`clientX`, `clientY`) points at,
 * given the rendered form of `source` in `container`.
 *
 * Falls back to the end of the source whenever the browser cannot resolve the
 * point — including under jsdom, which implements neither API. That is the same
 * place the caret would land with no mapping at all, so a fallback costs
 * precision rather than correctness.
 */
export function sourceOffsetAtPoint(
  container: HTMLElement,
  nodes: InlineNode[],
  source: string,
  clientX: number,
  clientY: number,
): number {
  const doc = container.ownerDocument as Document & CaretPositionSource;

  const position = doc.caretPositionFromPoint
    ? doc.caretPositionFromPoint(clientX, clientY)
    : doc.caretRangeFromPoint?.(clientX, clientY);
  if (!position) return source.length;

  const node = 'offsetNode' in position ? position.offsetNode : position.startContainer;
  const offset = 'offsetNode' in position ? position.offset : position.startOffset;

  const rendered = renderedOffsetOf(container, node, offset);
  if (rendered === null) return source.length;

  return inlineSourceOffset(nodes, rendered, source.length);
}
