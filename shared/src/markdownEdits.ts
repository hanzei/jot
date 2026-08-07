// Pure text transforms behind the markdown formatting bar in the note editor.
//
// They are deliberately free of React, react-native and the DOM so both clients
// share one set of editing rules and one test suite. Every function takes the
// current text plus the caret/selection and returns the text and where the
// caret/selection should end up afterwards — the caller is responsible for
// pushing both back into its own input.
//
// How that push happens is deliberately *not* shared, because the two platforms
// have opposite constraints: mobile sets state and forces the caret through the
// TextInput's controlled `selection` prop, while the webapp replays the change
// through the DOM (webapp/src/utils/textareaEdit.ts) so the browser's native
// undo stack survives. Keep platform specifics out of this module.

export interface TextSelection {
  start: number;
  end: number;
}

export interface EditorText {
  text: string;
  selection: TextSelection;
}

/**
 * A list line: indent, bullet marker, and an optional task checkbox. Only the
 * checkbox group is optional in either pattern, so groups 1 and 2 are always
 * captured on a match — hence the assertions on them below.
 */
const LIST_LINE = /^(\s*)([-*+] )(\[[ xX]\] )?/;
const HEADING_LINE = /^(\s*)(#{1,6}) /;
const INDENT = /^\s*/;

const MAX_HEADING_LEVEL = 3;

function indentOf(line: string): string {
  return INDENT.exec(line)?.[0] ?? '';
}

function lineStartAt(text: string, index: number): number {
  if (index <= 0) return 0;
  return text.lastIndexOf('\n', index - 1) + 1;
}

function lineEndAt(text: string, index: number): number {
  const next = text.indexOf('\n', index);
  return next === -1 ? text.length : next;
}

function ordered(selection: TextSelection): TextSelection {
  return selection.start <= selection.end
    ? { start: selection.start, end: selection.end }
    : { start: selection.end, end: selection.start };
}

/** Bounds of the block of whole lines the selection touches. */
function selectedBlock(state: EditorText): { start: number; end: number } {
  const { start, end } = ordered(state.selection);
  // A selection that ends exactly at a line start does not reach into the next
  // line, so anchor the last line on the character before it.
  return {
    start: lineStartAt(state.text, start),
    end: lineEndAt(state.text, end > start ? end - 1 : start),
  };
}

/** The whole lines the selection touches, in order. */
export function selectedLines(state: EditorText): string[] {
  const block = selectedBlock(state);
  return state.text.slice(block.start, block.end).split('\n');
}

/**
 * Rewrites every line the selection touches, keeping the selection over the
 * same text by shifting it by however much each line's prefix grew or shrank.
 */
function mapSelectedLines(state: EditorText, transform: (line: string) => string): EditorText {
  const { start, end } = ordered(state.selection);
  const block = selectedBlock(state);
  const lines = state.text.slice(block.start, block.end).split('\n');

  let firstDelta = 0;
  let totalDelta = 0;
  const nextLines = lines.map((line, index) => {
    const nextLine = transform(line);
    const delta = nextLine.length - line.length;
    if (index === 0) firstDelta = delta;
    totalDelta += delta;
    return nextLine;
  });

  return {
    text: state.text.slice(0, block.start) + nextLines.join('\n') + state.text.slice(block.end),
    selection: {
      start: Math.max(block.start, start + firstDelta),
      end: Math.max(block.start, end + totalDelta),
    },
  };
}

/**
 * True when a single `*` sits next to another one, i.e. it is really half of a
 * `**` bold marker. Without this an italic toggle would eat one asterisk off
 * each side of bold text and leave it mangled.
 */
function isHalfOfBoldMarker(text: string, markerStart: number, marker: string): boolean {
  if (marker !== '*') return false;
  return text[markerStart - 1] === '*' || text[markerStart + 1] === '*';
}

/** True when `marker` sits immediately outside the given range. */
function hasSurroundingMarker(text: string, start: number, end: number, marker: string): boolean {
  if (start < marker.length) return false;
  if (text.slice(start - marker.length, start) !== marker) return false;
  if (text.slice(end, end + marker.length) !== marker) return false;
  return (
    !isHalfOfBoldMarker(text, start - marker.length, marker) &&
    !isHalfOfBoldMarker(text, end, marker)
  );
}

/** True when the selection itself opens and closes with `marker`. */
function isWrappedInMarker(selected: string, marker: string): boolean {
  if (selected.length < marker.length * 2) return false;
  if (!selected.startsWith(marker) || !selected.endsWith(marker)) return false;
  return !isHalfOfBoldMarker(selected, 0, marker) &&
    !isHalfOfBoldMarker(selected, selected.length - marker.length, marker);
}

/**
 * Adds or removes an inline marker (`**` for bold, `*` for italic) around the
 * selection. With no selection it inserts an empty pair and parks the caret
 * between the two halves, so the next keystroke lands inside the markers.
 */
export function toggleInlineMarker(state: EditorText, marker: string): EditorText {
  const { text } = state;
  const { start, end } = ordered(state.selection);
  const width = marker.length;
  const selected = text.slice(start, end);

  // The markers are part of the selection: "**bold**" -> "bold".
  if (isWrappedInMarker(selected, marker)) {
    const inner = selected.slice(width, selected.length - width);
    return {
      text: text.slice(0, start) + inner + text.slice(end),
      selection: { start, end: start + inner.length },
    };
  }

  // The markers sit just outside the selection: "**[bold]**" -> "[bold]".
  // With an empty selection this is the "caret parked in an empty pair" case,
  // which removes the pair.
  if (hasSurroundingMarker(text, start, end, marker)) {
    return {
      text: text.slice(0, start - width) + selected + text.slice(end + width),
      selection: { start: start - width, end: end - width },
    };
  }

  const wrapped = marker + selected + marker;
  return {
    text: text.slice(0, start) + wrapped + text.slice(end),
    selection: { start: start + width, end: end + width },
  };
}

/**
 * Cycles the heading level of every selected line: none -> `##` -> `###` ->
 * none. An existing `#` joins the cycle at `##` rather than being dropped.
 */
export function cycleHeading(state: EditorText): EditorText {
  return mapSelectedLines(state, (line) => {
    const heading = HEADING_LINE.exec(line);
    const indent = heading ? heading[1]! : indentOf(line);
    const body = line.slice(heading ? heading[0].length : indent.length);
    const level = heading ? heading[2]!.length : 0;
    const nextLevel = level === 0 ? 2 : level >= MAX_HEADING_LEVEL ? 0 : level + 1;
    return nextLevel === 0 ? indent + body : `${indent}${'#'.repeat(nextLevel)} ${body}`;
  });
}

/**
 * Decides once for the whole selection whether a block toggle adds or removes,
 * so a mixed selection becomes uniformly formatted instead of inverting line by
 * line. Blank lines are left alone unless they are the only line.
 */
function toggleBlock(
  state: EditorText,
  isApplied: (line: string) => boolean,
  apply: (line: string) => string,
  remove: (line: string) => string,
): EditorText {
  const lines = selectedLines(state);
  const single = lines.length === 1;
  const relevant = single ? lines : lines.filter((line) => line.trim() !== '');
  const removing = relevant.length > 0 && relevant.every(isApplied);
  return mapSelectedLines(state, (line) => {
    if (!single && line.trim() === '') return line;
    return removing ? remove(line) : apply(line);
  });
}

/**
 * Toggles a `- ` bullet. A checklist line steps down to a plain bullet rather
 * than losing its indentation and marker in one press.
 */
export function toggleBullet(state: EditorText): EditorText {
  return toggleBlock(
    state,
    (line) => LIST_LINE.test(line),
    (line) => {
      const list = LIST_LINE.exec(line);
      if (list) return line; // already a bullet (or a checklist item)
      const indent = indentOf(line);
      return `${indent}- ${line.slice(indent.length)}`;
    },
    (line) => {
      const list = LIST_LINE.exec(line);
      if (!list) return line;
      // Checklist -> plain bullet; plain bullet -> no marker at all.
      const keep = list[3] ? list[1]!.length + list[2]!.length : list[1]!.length;
      return line.slice(0, keep) + line.slice(list[0].length);
    },
  );
}

/**
 * Toggles a `- [ ] ` checklist marker. Existing bullets are upgraded in place
 * and an already-checked `[x]` keeps its state.
 */
export function toggleCheckbox(state: EditorText): EditorText {
  return toggleBlock(
    state,
    (line) => LIST_LINE.exec(line)?.[3] !== undefined,
    (line) => {
      const list = LIST_LINE.exec(line);
      if (list?.[3]) return line;
      if (list) {
        const marker = list[1]!.length + list[2]!.length;
        return `${line.slice(0, marker)}[ ] ${line.slice(marker)}`;
      }
      const indent = indentOf(line);
      return `${indent}- [ ] ${line.slice(indent.length)}`;
    },
    (line) => {
      const list = LIST_LINE.exec(line);
      if (!list) return line;
      return list[1]! + line.slice(list[0].length);
    },
  );
}

/**
 * Where a newline was inserted, or null if the change was anything else.
 *
 * The caret is checked first because a diff cannot always tell: typing Enter at
 * the end of `- one` in "- one\ntail" produces the same string as typing it at
 * the start of `tail`, and only the caret distinguishes them. The diff is the
 * fallback for when the reported caret is stale.
 */
function newlineInsertionPoint(
  previous: EditorText,
  next: string,
): { insertedAt: number; resumeAt: number } | null {
  const { text } = previous;
  const { start, end } = ordered(previous.selection);
  if (
    start <= text.length &&
    end <= text.length &&
    next === text.slice(0, start) + '\n' + text.slice(end)
  ) {
    // Enter may have replaced a selection, so the old text resumes at its end.
    return { insertedAt: start, resumeAt: end };
  }

  if (next.length !== text.length + 1) return null;
  let insertedAt = 0;
  while (insertedAt < text.length && text[insertedAt] === next[insertedAt]) {
    insertedAt += 1;
  }
  if (next[insertedAt] !== '\n') return null;
  if (next.slice(insertedAt + 1) !== text.slice(insertedAt)) return null;
  return { insertedAt, resumeAt: insertedAt };
}

/**
 * Keeps a list going when Enter is pressed at the end of a list item, and
 * clears the marker instead when the item is empty (the usual way out of a
 * list). Returns null when the change was not a newline insertion on a list
 * line, meaning the caller should keep the text as typed.
 *
 * This works off the text change rather than a key handler because onKeyPress
 * does not fire reliably for the Android soft keyboard.
 */
export function continueListOnNewline(previous: EditorText, next: string): EditorText | null {
  const insertion = newlineInsertionPoint(previous, next);
  if (insertion === null) return null;
  const { insertedAt, resumeAt } = insertion;

  const lineStart = lineStartAt(previous.text, insertedAt);
  const beforeCaret = previous.text.slice(lineStart, insertedAt);
  const list = LIST_LINE.exec(beforeCaret);
  if (!list) return null;

  // Enter on an empty list item ends the list: drop the marker, add no line.
  if (beforeCaret.slice(list[0].length).trim() === '') {
    return {
      text: previous.text.slice(0, lineStart) + previous.text.slice(resumeAt),
      selection: { start: lineStart, end: lineStart },
    };
  }

  const marker = list[1]! + list[2]! + (list[3] ? '[ ] ' : '');
  const caret = insertedAt + 1 + marker.length;
  return {
    text: next.slice(0, insertedAt + 1) + marker + next.slice(insertedAt + 1),
    selection: { start: caret, end: caret },
  };
}

/** Keeps a selection inside the bounds of `text`. */
export function clampSelection(selection: TextSelection, text: string): TextSelection {
  const limit = text.length;
  const start = Math.min(Math.max(selection.start, 0), limit);
  const end = Math.min(Math.max(selection.end, 0), limit);
  return start <= end ? { start, end } : { start: end, end: start };
}
