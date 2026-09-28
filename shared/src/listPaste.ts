// Splitting a multi-line paste into a list note's checklist items, shared by
// the webapp and mobile note editors so the two cannot drift. It is a pure
// function over plain item data; each client keeps its own event handling,
// focus management, and error/undo UI around it.

import { VALIDATION } from './constants';
import { normalizeItemOrder, type ListItem } from './listItems';
import { parseTextLineAsListItem, type ConvertedListItem } from './noteConversion';
import { truncateToCodePoints } from './text';

export interface PasteCaretContext {
  /** Text of the target item before the caret (or selection start). */
  before: string;
  /** Text of the target item after the caret (or selection end). */
  after: string;
}

export interface PasteSplitSuccess {
  /** The whole new item list, normalized (positions 0..N, groups contiguous). */
  items: ListItem[];
  /** IDs of the items the paste inserted, in list order; empty when none. */
  insertedIds: string[];
  /** The item the caret belongs in afterwards: the last inserted item, or the target. */
  caretItemId: string;
  /** Caret offset within caretItemId's text: just after the pasted text, before `after`. */
  caretOffset: number;
}

export interface PasteSplitError {
  error: 'tooManyItems';
  max: number;
}

export type PasteSplitResult = PasteSplitSuccess | PasteSplitError;

/**
 * Applies a paste into the list item at `targetIndex` (an index into `items`),
 * splitting the pasted text into one item per usable line:
 *
 * - Each line is parsed with `parseTextLineAsListItem`, the same parser the
 *   text-to-list conversion uses, so markdown list/checkbox markers are
 *   stripped and `[x]` carries its completed state. Lines that strip to
 *   nothing (blank lines, a bare `#`) are dropped.
 * - The first line joins `before` in the target item and the last line takes
 *   `after`; the lines between become new items inserted right after the
 *   target, in the target's group (same `parentId`). Every item's text is
 *   truncated to `ITEM_TEXT_MAX_LENGTH`.
 * - A line is completed if it is marked `[x]` **or** the target item is
 *   completed. Pasting into an unchecked row therefore behaves as before,
 *   while pasting into a checked row keeps the row and its new siblings in the
 *   checked section instead of scattering unmarked lines into the unchecked
 *   list.
 * - The paste is rejected with `tooManyItems` when it would push the note past
 *   `ITEM_MAX_COUNT`. The server rejects such a save with a 422, which the
 *   mobile sync queue treats as permanent, so the check must happen here.
 *
 * With no usable lines at all, the target's text becomes `before + after` (the
 * paste replaced the selection with nothing). Returns null when `targetIndex`
 * is out of range.
 */
export function splitPasteIntoItems(
  items: ListItem[],
  targetIndex: number,
  pastedText: string,
  { before, after }: PasteCaretContext,
  newId: () => string,
): PasteSplitResult | null {
  const target = items[targetIndex];
  if (!target) return null;

  const lines = pastedText
    .split(/\r\n|\r|\n/)
    .map(parseTextLineAsListItem)
    .filter((line): line is ConvertedListItem => line !== null);

  const insertCount = Math.max(0, lines.length - 1);
  // Checked before building any items, so a huge clipboard payload does not
  // allocate an object and an ID per line only to be discarded.
  if (insertCount > 0 && items.length + insertCount > VALIDATION.ITEM_MAX_COUNT) {
    return { error: 'tooManyItems', max: VALIDATION.ITEM_MAX_COUNT };
  }

  const max = VALIDATION.ITEM_TEXT_MAX_LENGTH;
  const lastIndex = lines.length - 1;
  // prefix is the item's text up to the caret; `after` is appended only to the
  // last line (or to the target when nothing is inserted).
  const prefixFor = (i: number): string => (i === 0 ? before : '') + (lines[i]?.text ?? '');
  const textFor = (i: number): string => truncateToCodePoints(prefixFor(i) + (i === Math.max(0, lastIndex) ? after : ''), max);
  const completedFor = (line: ConvertedListItem | undefined): boolean => target.completed || (line?.completed ?? false);

  const updatedTarget: ListItem = { ...target, text: textFor(0), completed: completedFor(lines[0]) };

  const inserted: ListItem[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!; // i < lines.length
    inserted.push({
      id: newId(),
      text: textFor(i),
      completed: completedFor(line),
      position: 0,
      parentId: target.parentId,
      assigned_to: '',
    });
  }

  const next = [...items];
  next.splice(targetIndex, 1, updatedTarget, ...inserted);

  const caretLine = Math.max(0, lastIndex);
  const caretItem = inserted[inserted.length - 1] ?? updatedTarget;
  return {
    items: normalizeItemOrder(next),
    insertedIds: inserted.map(item => item.id),
    caretItemId: caretItem.id,
    caretOffset: truncateToCodePoints(prefixFor(caretLine), max).length,
  };
}
