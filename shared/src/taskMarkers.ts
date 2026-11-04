// Locating task-list markers (`- [ ]` / `- [x]`) in text-note source, so a
// rendered checkbox can be toggled by rewriting one character of `content`.
//
// The rendered checkboxes are numbered in document order — the order
// `normalizeBlockTokens` walks the tokens in, which is also the order they
// appear in. The work here is the reverse direction: given the Nth checkbox,
// find the space or `x` between its brackets in the source.
//
// marked does not report source positions, so this uses what it does
// guarantee:
//
// 1. The `raw` of the top-level tokens concatenates back to the source, so each
//    top-level block's start offset is known exactly.
// 2. Inside one block, a task item's first line matches `TASK_LINE`: its
//    indentation, quote markers and list markers, then the box.
// 3. Every checkbox token belongs to a `list_item` token whose `raw` starts with
//    that same first line — de-indented and with quote markers stripped, but
//    identical from the `[` on.
//
// Within a block, the lines matching `TASK_LINE` are paired in order with the
// block's checkbox tokens, and **each pair is verified**: the source line from
// its `[` must equal the owning item's first line from its `[`. A line can
// match without being a task (`- [ ]` with nothing after it, task syntax in a
// code block nested in a list item), and a construct this pattern does not
// describe could hide a real one; either way the block's lines stop lining up
// with its items, by count or by text. A block that does not line up gets no
// offsets at all — its checkboxes render inert rather than risk rewriting the
// wrong line.
//
// The line-plus-regex approach follows Memos' `markdown-task-actions.ts` (MIT).
// Spec: docs/specs/markdown-rendering.md §2.4.

import type { BlockMarkdownToken } from './blockMarkdown';

/**
 * A task item's first line up to its box: indentation, then any run of quote
 * markers and list markers in any order (`> - `, `- > - `, `1. - `), then the
 * box. Group 1 is everything before the `[`, so the marker character sits at
 * `match[1].length + 1`.
 *
 * Shaped so whitespace has exactly one place to go — the `[ \t]*` that closes
 * the group it follows. A pattern where two quantifiers can claim the same
 * whitespace backtracks exponentially on input like `*\t\t*\t\t*…`, and note
 * text is user-controlled.
 */
const TASK_LINE = /^([ \t]*(?:(?:>|(?:[-*+]|\d{1,9}[.)])[ \t])[ \t]*)*)\[[ xX]\]/;

/**
 * marked lexes CRLF and lone CR as LF, so `raw` only lines up with LF source.
 * Offsets from `taskMarkerOffsets` index this normalized text;
 * `toggleTaskMarkerAt` maps them back onto the original.
 */
export function normalizeTaskSource(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

/** A line from its first `[` on, without trailing whitespace; `null` if it has none. */
function fromBox(line: string): string | null {
  const box = line.indexOf('[');
  return box === -1 ? null : line.slice(box).trimEnd();
}

/**
 * For each checkbox under `tokens`, in document order, the first line of the
 * list item it belongs to, from its `[` on (see `fromBox`).
 */
function checkboxItemLines(tokens: BlockMarkdownToken[], itemRaw: string | null, out: (string | null)[]): void {
  for (const token of tokens) {
    if (token.type === 'checkbox') {
      out.push(itemRaw === null ? null : fromBox(itemRaw.split('\n', 1)[0] ?? ''));
    }
    if (token.items) {
      for (const item of token.items) checkboxItemLines(item.tokens ?? [], item.raw, out);
    }
    if (token.tokens) checkboxItemLines(token.tokens, itemRaw, out);
  }
}

/**
 * The offset of every rendered checkbox's marker character (the space or `x`
 * between the brackets) in `normalizeTaskSource(content)`, in document order;
 * `null` for a checkbox that could not be located safely.
 *
 * `tokens` must be `Lexer.lex(content, BLOCK_LEXER_OPTIONS)`.
 */
export function taskMarkerOffsets(content: string, tokens: BlockMarkdownToken[]): (number | null)[] {
  const source = normalizeTaskSource(content);
  const offsets: (number | null)[] = [];
  let cursor = 0;
  // Once a raw fails to line up, every later block start is unknown.
  let aligned = true;

  for (const token of tokens) {
    const start = cursor;
    cursor += token.raw.length;
    const itemLines: (string | null)[] = [];
    checkboxItemLines([token], null, itemLines);
    if (itemLines.length === 0) continue;

    if (aligned && !source.startsWith(token.raw, start)) aligned = false;

    const found: { offset: number; line: string | null }[] = [];
    if (aligned) {
      let lineStart = start;
      for (const line of token.raw.split('\n')) {
        const match = TASK_LINE.exec(line);
        // Group 1 always participates in a match.
        if (match) found.push({ offset: lineStart + match[1]!.length + 1, line: fromBox(line) });
        lineStart += line.length + 1;
      }
    }

    const linesUp = aligned
      && found.length === itemLines.length
      && found.every((match, i) => match.line !== null && match.line === itemLines[i]);
    if (linesUp) {
      offsets.push(...found.map((match) => match.offset));
    } else {
      offsets.push(...itemLines.map(() => null));
    }
  }

  return offsets;
}

/**
 * Flips the marker at `offset` — one of `taskMarkerOffsets`' results, an index
 * into `normalizeTaskSource(content)` — between `[ ]` and `[x]`, keeping
 * `content`'s own line endings. `null` if `offset` is not a marker.
 */
export function toggleTaskMarkerAt(content: string, offset: number): string | null {
  // Walk the normalized offset back onto `content`: each CRLF is one character
  // in the normalized text and two here. A lone CR is one in both.
  let original = 0;
  for (let normalized = 0; normalized < offset && original < content.length; normalized++) {
    original += content[original] === '\r' && content[original + 1] === '\n' ? 2 : 1;
  }
  const marker = content[original];
  if (content[original - 1] !== '[' || content[original + 1] !== ']') return null;
  const next = marker === ' ' ? 'x' : marker === 'x' || marker === 'X' ? ' ' : null;
  if (next === null) return null;
  return content.slice(0, original) + next + content.slice(original + 1);
}
