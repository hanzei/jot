import { inlineSourceOffset, type InlineNode } from '@jot/shared';

/**
 * Turning a tap on rendered list-item text into a caret position in the source
 * behind it.
 *
 * The editable row shows rendered Markdown until it holds the caret, so a tap
 * has to answer a question a plain TextInput answers for itself: the user
 * pointed at character 4 of `buy milk`, and the field holds `buy **milk**`,
 * where that character is at 6.
 *
 * Two halves, the same split as `webapp/src/utils/inlineCaret.ts`, because only
 * one of them can be tested without a layout engine: the platform reports where
 * the lines of a `<Text>` landed, and this module maps a point inside them to an
 * offset in the source. The webapp gets its half from `caretPositionFromPoint`;
 * React Native has no equivalent, so the mapping is reconstructed from the line
 * boxes `onTextLayout` reports. Everything from the rendered offset onwards —
 * `inlineSourceOffset` and the source spans it walks — is shared with the
 * webapp.
 */

/**
 * The fields this module reads from a React Native `TextLayoutLine`, declared
 * structurally so a test can build one out of five numbers rather than the
 * nine-field line RN reports. RN's own type is assignable to it.
 */
export interface RenderedTextLine {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

/**
 * The visible text of a node tree as *mobile* renders it.
 *
 * Not `flattenInlineNodes`, which renders a `br` as a space because it builds
 * accessibility labels, and a label is one line. Here the string has to match
 * what is on screen character for character, and mobile breaks a line with a
 * literal newline (`inlineNodes.tsx`) — which is also the one character
 * `inlineSourceOffset` counts a `br` as, so the two walks agree on every offset
 * after the first line break.
 */
export function renderedInlineText(nodes: InlineNode[]): string {
  let out = '';

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'code':
        out += node.value;
        break;
      case 'br':
        out += '\n';
        break;
      default:
        out += renderedInlineText(node.children);
        break;
    }
  }

  return out;
}

/**
 * Where each reported line starts inside `rendered`.
 *
 * Located by search rather than by summing lengths, because a line's `text` is
 * not always exactly the slice it came from: a soft wrap may or may not carry
 * the space it broke at, and a hard break may or may not carry its newline,
 * depending on the platform. Searching forward from the previous line's end
 * absorbs both without having to know which platform is running.
 */
function lineStarts(rendered: string, lines: readonly RenderedTextLine[]): number[] {
  const starts: number[] = [];
  let cursor = 0;

  for (const line of lines) {
    const at = rendered.indexOf(line.text, cursor);
    const start = at === -1 ? cursor : at;
    starts.push(start);
    cursor = start + line.text.length;
  }

  return starts;
}

/**
 * The offset in the rendered text that the point (`x`, `y`) points at, given
 * where the lines landed.
 *
 * The horizontal step is a linear interpolation across the line, which is exact
 * only in a monospaced face: in a proportional one a tap lands a character or
 * two off inside a long line. That is the same order of error the source
 * mapping already tolerates for a reconstructed image or an escape
 * (`inlineSourceOffset`), and it is visible and correctable the moment the caret
 * appears. Measuring per character would mean laying every substring out
 * separately, which is a real cost on every row of every list note.
 */
export function renderedOffsetAtPoint(
  rendered: string,
  lines: readonly RenderedTextLine[],
  x: number,
  y: number,
): number {
  if (lines.length === 0) return rendered.length;

  const starts = lineStarts(rendered, lines);

  // The first line whose box the point is above the bottom of. A tap above
  // everything lands on the first line, one below everything on the last —
  // clamping rather than missing, since a tap anywhere in the row means the row.
  let index = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    if (y < lines[i]!.y + lines[i]!.height) {
      index = i;
      break;
    }
  }

  const line = lines[index]!;
  const start = starts[index]!;
  if (line.text.length === 0 || line.width <= 0) return start;

  const ratio = (x - line.x) / line.width;
  const within = Math.round(ratio * line.text.length);
  return start + Math.max(0, Math.min(line.text.length, within));
}

/**
 * The offset in `source` that a tap at (`x`, `y`) points at, given the lines the
 * rendered form of `source` laid out into.
 *
 * Falls back to the end of the source when the text has not been measured yet —
 * the first tap on a row that mounted this frame, in practice. That is where the
 * caret would land with no mapping at all, so the fallback costs precision
 * rather than correctness.
 */
export function sourceOffsetAtPoint(
  nodes: InlineNode[],
  source: string,
  lines: readonly RenderedTextLine[] | null,
  x: number,
  y: number,
): number {
  if (!lines || lines.length === 0) return source.length;

  const rendered = renderedInlineText(nodes);
  return inlineSourceOffset(nodes, renderedOffsetAtPoint(rendered, lines, x, y), source.length);
}
