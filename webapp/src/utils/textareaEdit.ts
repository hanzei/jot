// Applies a whole-text edit to a textarea without destroying the browser's
// native undo stack.
//
// The obvious implementation — setContent(next) and let React re-render — is
// wrong in a way that is easy to miss, because the damage is to state the app
// does not own. Measured in Chromium against a textarea wired the way React
// wires one:
//
//   node.value = next   (React's commit path)  -> undo stack emptied, and redo
//                                                 replays stale transactions,
//                                                 duplicating text
//   setRangeText(...)                          -> undo stack emptied
//   execCommand('insertText', ...)             -> undo restores the pre-edit
//                                                 text, further undos continue
//                                                 into the typing history
//
// So a toolbar press implemented the obvious way would not merely be
// un-undoable: it would silently discard everything the user had typed before
// it. execCommand replays the edit as if the user had made it, which is exactly
// what we want a formatting button to be.
//
// execCommand is deprecated, and there is no replacement for "edit this field
// the way a user would" — every editor on the web depends on it for this, which
// is why it is still here. It reports failure by returning false, and the
// caller falls back to a plain state update (losing undo, keeping the edit).

/** The span in which `previous` and `next` actually differ. */
export function changedRange(
  previous: string,
  next: string,
): { start: number; end: number; replacement: string } {
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) {
    start += 1;
  }

  // Walk in from the end, but never back past `start` — otherwise a repeated
  // character ("aa" -> "aaa") would be counted from both ends and overlap.
  let suffix = 0;
  const maxSuffix = Math.min(previous.length - start, next.length - start);
  while (
    suffix < maxSuffix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    start,
    end: previous.length - suffix,
    replacement: next.slice(start, next.length - suffix),
  };
}

/**
 * Replaces the textarea's content with `next` as an undoable edit, then puts the
 * caret/selection where the caller asks.
 *
 * Returns false when the browser refused the edit, in which case nothing has
 * been written and the caller should fall back to setting state directly.
 *
 * Only the changed span is replaced, so undo steps back over the formatting
 * markers rather than over the whole note. The resulting `input` event carries
 * `inputType: 'insertText'`, so React's onChange runs and state follows on its
 * own — callers must not also set the text themselves.
 */
export function applyTextareaEdit(
  textarea: HTMLTextAreaElement,
  next: string,
  selection: { start: number; end: number },
): boolean {
  const previous = textarea.value;

  if (previous !== next) {
    // Absent in jsdom, and the caller has a working fallback, so this is a
    // capability check rather than a missing polyfill.
    if (typeof document.execCommand !== 'function') return false;
    const range = changedRange(previous, next);
    // execCommand acts on the focused element's current selection.
    textarea.focus();
    textarea.setSelectionRange(range.start, range.end);
    // A pure deletion (clearing a "- " bullet) has an empty replacement, and
    // insertText with an empty string is the right call for it — verified to
    // delete the selection and to undo cleanly, same as execCommand('delete').
    if (!document.execCommand('insertText', false, range.replacement)) return false;
  }

  // execCommand leaves the caret after the inserted text, which is rarely where
  // the transform wants it — toggling bold on an empty selection wants it
  // *between* the markers. Selection changes do not touch the undo stack.
  textarea.focus();
  textarea.setSelectionRange(selection.start, selection.end);
  return true;
}
