// Locating task-list markers (`- [ ]` / `- [x]`) in text-note source, so a
// rendered checkbox can be toggled by rewriting one character of `content`.
//
// The rendered checkboxes are numbered in document order — the order
// `normalizeBlockTokens` walks the tokens in, which is also the order they
// appear in. The work here is the reverse direction: given the Nth checkbox,
// find the space or `x` between its brackets in the source.
//
// marked does not report source positions, so this uses two facts it does
// guarantee:
//
// 1. The `raw` of the top-level tokens concatenates back to the source, so each
//    top-level block's start offset is known exactly.
// 2. Inside one block, every task item's first line matches `TASK_LINE`
//    (blockquote `>` prefixes and outer list markers included).
//
// Within a block, the lines matching `TASK_LINE` are paired in order with the
// block's checkbox tokens. A line can match without being a task — inside a
// fenced code block nested in a list item, or `- [ ]` with nothing after it —
// but a real task line always matches, so a false match always shows up as a
// count mismatch. A block whose counts disagree gets no offsets at all: its
// checkboxes render inert rather than risk rewriting the wrong line.
//
// The line-plus-regex approach follows Memos' `markdown-task-actions.ts` (MIT).
// Spec: docs/specs/markdown-rendering.md §2.4.

import type { BlockMarkdownToken } from './blockMarkdown';

/**
 * A task item's first line: any quote markers and list markers before its own
 * (an item may begin with another list's marker), its marker, then the box.
 * Group 1 is everything before the `[`, so the marker character sits at
 * `match[1].length + 1`.
 *
 * Each repeated list-marker group starts with the marker itself, never with
 * whitespace: a leading `[ \t]*` there would compete with the previous group's
 * trailing `[ \t]+` for the same characters and backtrack exponentially on
 * input like `*\t\t*\t\t*…` — note text is user-controlled.
 */
const TASK_LINE = /^((?:[ \t]*>)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)+)\[[ xX]\]/;

/**
 * marked lexes CRLF and lone CR as LF, so `raw` only lines up with source that
 * already uses LF. Callers lex and map this normalized text, and a toggle
 * writes it back — the only change beyond the marker itself.
 */
export function normalizeTaskSource(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

function countCheckboxes(tokens: BlockMarkdownToken[]): number {
  let count = 0;
  for (const token of tokens) {
    if (token.type === 'checkbox') count++;
    if (token.items) count += countCheckboxes(token.items);
    if (token.tokens) count += countCheckboxes(token.tokens);
  }
  return count;
}

/**
 * The source offset of every rendered checkbox's marker character (the space
 * or `x` between the brackets), in document order; `null` for a checkbox that
 * could not be located safely.
 *
 * `content` must already be normalized with `normalizeTaskSource`, and
 * `tokens` must be `Lexer.lex(content, BLOCK_LEXER_OPTIONS)` of it.
 */
export function taskMarkerOffsets(content: string, tokens: BlockMarkdownToken[]): (number | null)[] {
  const offsets: (number | null)[] = [];
  let cursor = 0;
  // Once a raw fails to line up, every later block start is unknown.
  let aligned = true;

  for (const token of tokens) {
    const start = cursor;
    cursor += token.raw.length;
    const checkboxes = countCheckboxes([token]);
    if (checkboxes === 0) continue;

    if (aligned && !content.startsWith(token.raw, start)) aligned = false;
    if (!aligned) {
      for (let i = 0; i < checkboxes; i++) offsets.push(null);
      continue;
    }

    const found: number[] = [];
    let lineStart = start;
    for (const line of token.raw.split('\n')) {
      const match = TASK_LINE.exec(line);
      // Group 1 always participates in a match.
      if (match) found.push(lineStart + match[1]!.length + 1);
      lineStart += line.length + 1;
    }

    if (found.length === checkboxes) {
      offsets.push(...found);
    } else {
      for (let i = 0; i < checkboxes; i++) offsets.push(null);
    }
  }

  return offsets;
}

/**
 * Flips the marker at `offset` (one of `taskMarkerOffsets`' results) between
 * `[ ]` and `[x]`.
 */
export function toggleTaskMarkerAt(content: string, offset: number): string {
  const marker = content[offset];
  if (marker === undefined || content[offset - 1] !== '[' || content[offset + 1] !== ']') return content;
  const next = marker === ' ' ? 'x' : ' ';
  return content.slice(0, offset) + next + content.slice(offset + 1);
}
