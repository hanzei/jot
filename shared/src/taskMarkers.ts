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
// block's checkbox tokens, and each pair is verified against the owning item's
// first line; a block that does not line up stays inert. Why a count alone is
// not enough is in docs/specs/markdown-rendering.md §2.4.
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

/** A line from its first `[` on, without trailing whitespace. */
function fromBox(line: string): string {
  return line.slice(line.indexOf('[')).trimEnd();
}

/**
 * For each checkbox under `tokens`, in document order, the first line of the
 * list item it belongs to, from its `[` on. A checkbox token only exists inside
 * a task item, whose first line holds the box.
 */
function checkboxItemLines(tokens: BlockMarkdownToken[], itemRaw: string, out: string[]): void {
  for (const token of tokens) {
    if (token.type === 'checkbox') out.push(fromBox(itemRaw.split('\n', 1)[0] ?? ''));
    if (token.items) {
      for (const item of token.items) checkboxItemLines(item.tokens ?? [], item.raw, out);
    }
    if (token.tokens) checkboxItemLines(token.tokens, itemRaw, out);
  }
}

/**
 * The offset of every rendered checkbox's marker character (the space or `x`
 * between the brackets), in document order; `null` — or a shorter array — for
 * a checkbox that could not be located safely. Offsets index `content` with
 * CRLF and lone CR folded to LF, as marked lexes it; `toggleTaskMarkerAt` maps
 * them back.
 *
 * `tokens` must be `Lexer.lex(content, BLOCK_LEXER_OPTIONS)`.
 */
export function taskMarkerOffsets(content: string, tokens: BlockMarkdownToken[]): (number | null)[] {
  const source = content.replace(/\r\n?/g, '\n');
  const offsets: (number | null)[] = [];
  let cursor = 0;

  for (const token of tokens) {
    const start = cursor;
    cursor += token.raw.length;
    const itemLines: string[] = [];
    checkboxItemLines([token], '', itemLines);
    if (itemLines.length === 0) continue;
    // Once a raw fails to line up, every later block start is unknown.
    if (!source.startsWith(token.raw, start)) break;

    const found: { offset: number; line: string }[] = [];
    let lineStart = start;
    for (const line of token.raw.split('\n')) {
      const match = TASK_LINE.exec(line);
      // Group 1 always participates in a match.
      if (match) found.push({ offset: lineStart + match[1]!.length + 1, line: fromBox(line) });
      lineStart += line.length + 1;
    }

    const linesUp = found.length === itemLines.length
      && found.every((match, i) => match.line === itemLines[i]);
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
 * into the LF-folded source — between `[ ]` and `[x]`, keeping
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
