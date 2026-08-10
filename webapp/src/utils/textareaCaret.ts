/**
 * Where the caret sits inside a `<textarea>`, measured in pixels and lines
 * rather than characters.
 *
 * List rows wrap, so "press Down" means two different things depending on where
 * the caret is: move it to the next visual line, or leave the row for the next
 * one. `selectionStart` cannot tell those apart — it is a character offset, and
 * a soft wrap leaves no mark in the value at all. Neither can `scrollHeight`,
 * which describes the whole field and not the caret in it.
 *
 * There is no DOM inside a textarea to measure — its value is not a text node,
 * so `Range` cannot address it and nothing has a rect. Everything here works by
 * mirroring the value into a hidden `<div>` that wraps identically (same font,
 * same content width, same wrapping rules) and measuring the mirror instead.
 *
 * Like `inlineCaret`, this half cannot be tested without a layout engine: jsdom
 * reports every offset as 0. Callers get a documented degenerate answer there —
 * one line, no horizontal position — rather than a wrong one.
 */

/**
 * Copied onto the mirror, because each of these changes where a line breaks or
 * how far along it a glyph lands. Colour, background and opacity deliberately
 * are not: they cost a style recalc and cannot move a character.
 */
const WRAPPING_PROPERTIES = [
  'direction',
  'fontFamily',
  'fontSize',
  'fontStretch',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'overflowWrap',
  'tabSize',
  'textAlign',
  'textIndent',
  'textTransform',
  'whiteSpace',
  'wordBreak',
  'wordSpacing',
] as const;

/**
 * Line boxes are a whole `line-height` apart, so anything sub-pixel is the same
 * line rounded differently rather than a neighbouring one.
 */
const SAME_LINE_PX = 1;

interface Mirror {
  host: HTMLDivElement;
  /** Everything before the caret. */
  before: HTMLSpanElement;
  /** Everything after it, and therefore positioned exactly where it sits. */
  marker: HTMLSpanElement;
}

let cached: Mirror | null = null;

function ensureMirror(doc: Document): Mirror {
  if (cached && cached.host.ownerDocument === doc && cached.host.isConnected) return cached;

  const host = doc.createElement('div');
  // Off-screen rather than `display: none`: an element with no box has no
  // layout, and layout is the entire point of this one.
  host.setAttribute('aria-hidden', 'true');
  host.style.position = 'absolute';
  host.style.top = '0';
  host.style.left = '-9999px';
  host.style.visibility = 'hidden';
  // Padding and border stay at zero and the width below is the content width,
  // so every offset read back is already relative to the textarea's content
  // box — the same origin the caret is placed against.
  host.style.boxSizing = 'content-box';
  host.style.padding = '0';
  host.style.border = '0';

  // Two spans rather than a bare text node and a span. Both halves then go in
  // through `textContent`, which is the assignment static analysis recognises as
  // text — a `CharacterData.data` write carrying a note's contents reads as an
  // HTML sink to CodeQL even though it parses no markup. An unstyled inline span
  // is not a break opportunity and adds no box of its own, so the mirror wraps
  // exactly as it did.
  const before = doc.createElement('span');
  const marker = doc.createElement('span');
  host.appendChild(before);
  host.appendChild(marker);
  doc.body.appendChild(host);

  cached = { host, before, marker };
  return cached;
}

function syncMirror(textarea: HTMLTextAreaElement): Mirror | null {
  const doc = textarea.ownerDocument;
  const view = doc.defaultView;
  if (!view || !doc.body) return null;

  const mirror = ensureMirror(doc);
  const styles = view.getComputedStyle(textarea);
  for (const property of WRAPPING_PROPERTIES) {
    mirror.host.style[property] = styles[property];
  }

  // `clientWidth` less horizontal padding is the width text actually wraps at.
  // The computed `width` is not: it depends on `box-sizing` and still counts a
  // scrollbar the field may be showing, either of which moves the wrap point.
  const contentWidth = textarea.clientWidth
    - (Number.parseFloat(styles.paddingLeft) || 0)
    - (Number.parseFloat(styles.paddingRight) || 0);
  mirror.host.style.width = `${Math.max(contentWidth, 0)}px`;

  return mirror;
}

/**
 * Position of the caret at `index`, relative to the content box.
 *
 * The marker carries the rest of the value rather than being empty, for two
 * reasons: the text after the caret has to be present or it cannot push the
 * caret's own line around as it does in the textarea, and an inline box with no
 * content has no position to report. `'.'` stands in at the very end of the
 * value — including on the empty line a trailing newline opens, which is a line
 * the caret can reach and nothing else would give a box to.
 */
function measure(mirror: Mirror, value: string, index: number): { top: number; left: number } {
  mirror.before.textContent = value.slice(0, index);
  mirror.marker.textContent = value.slice(index) || '.';
  return { top: mirror.marker.offsetTop, left: mirror.marker.offsetLeft };
}

export interface CaretLine {
  /** The caret is on the first visual line, so ArrowUp has nowhere left to go. */
  isFirstLine: boolean;
  /** The caret is on the last visual line, so ArrowDown has nowhere left to go. */
  isLastLine: boolean;
  /** Distance from the content box's left edge, in CSS pixels. */
  x: number;
}

/**
 * Which visual line the caret at `index` is on, and how far along it.
 *
 * Reports a single line when the layout cannot be measured, which makes both
 * boundaries true: a caller deciding whether an arrow key belongs to the caret
 * or to something outside the field then behaves as it would for a genuinely
 * one-line value.
 */
export function getCaretLine(textarea: HTMLTextAreaElement, index: number): CaretLine {
  const mirror = syncMirror(textarea);
  if (!mirror) return { isFirstLine: true, isLastLine: true, x: 0 };

  const value = textarea.value;
  const caret = measure(mirror, value, index);
  const start = measure(mirror, value, 0);
  const end = measure(mirror, value, value.length);

  return {
    isFirstLine: caret.top - start.top < SAME_LINE_PX,
    isLastLine: end.top - caret.top < SAME_LINE_PX,
    x: caret.left,
  };
}

export type LineEdge = 'first' | 'last';

/**
 * The offset on `textarea`'s first or last visual line whose caret sits closest
 * to `x` — what a caret arriving from another field should snap to, so it keeps
 * its column across the move.
 *
 * Returns null when there is no layout to measure (jsdom, or a field with no
 * box yet), which is a signal to fall back rather than a position: every offset
 * would otherwise measure identically and the first one would win by accident.
 */
export function getOffsetAtLine(
  textarea: HTMLTextAreaElement,
  edge: LineEdge,
  x: number,
): number | null {
  const mirror = syncMirror(textarea);
  if (!mirror) return null;

  const value = textarea.value;
  if (value.length === 0) return 0;

  const start = measure(mirror, value, 0);
  const end = measure(mirror, value, value.length);
  // A value with width has to place its two ends somewhere different. Both at
  // the same point means nothing was measured at all.
  if (Math.abs(end.top - start.top) < SAME_LINE_PX && Math.abs(end.left - start.left) < SAME_LINE_PX) {
    return null;
  }

  const lineTop = edge === 'first' ? start.top : end.top;
  const lowest = edge === 'first' ? 0 : firstOffsetOnLine(mirror, value, lineTop);
  const highest = edge === 'first' ? lastOffsetOnLine(mirror, value, lineTop) : value.length;
  return offsetClosestToX(mirror, value, lowest, highest, x);
}

/**
 * The three searches below all rely on the same property: a caret's `top` never
 * decreases as its offset grows, and within one line neither does its `left`.
 * That makes each of them a bisection over offsets — a dozen measurements for a
 * row of any length, instead of one per character.
 */

function firstOffsetOnLine(mirror: Mirror, value: string, top: number): number {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (measure(mirror, value, mid).top < top - SAME_LINE_PX) low = mid + 1;
    else high = mid;
  }
  return low;
}

function lastOffsetOnLine(mirror: Mirror, value: string, top: number): number {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (measure(mirror, value, mid).top > top + SAME_LINE_PX) high = mid - 1;
    else low = mid;
  }
  return low;
}

function offsetClosestToX(
  mirror: Mirror,
  value: string,
  lowest: number,
  highest: number,
  x: number,
): number {
  let low = lowest;
  let high = highest;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (measure(mirror, value, mid).left < x) low = mid + 1;
    else high = mid;
  }
  // `low` is the first offset at or past `x`; the character before it is the
  // other candidate, and whichever is nearer is where the caret looks like it
  // belongs. Landing between two characters always rounds to one of them.
  if (low <= lowest) return lowest;
  const after = measure(mirror, value, low).left;
  const before = measure(mirror, value, low - 1).left;
  return after - x < x - before ? low : low - 1;
}
