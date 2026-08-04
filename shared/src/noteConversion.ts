import type { NoteItem } from './types';

// Text ↔ list conversion.
//
// Conversion mirrors what each note type *renders* (docs/specs/markdown-rendering.md):
// text-note content renders the full feature set, and list-item text renders the
// strictly inline subset of it (§2.1). So converting has to remove exactly the
// block syntax and nothing else — inline syntax survives verbatim, because the
// item renders it the same way the text note did.
//
// That is why there is no inline stripper here any more. Reducing `**Buy** milk`
// to `Buy milk` was the readable choice while item text was plain; once items
// render bold it deletes formatting the destination would have shown. Block
// syntax is removed instead because the item structurally replaces it — an item
// has its own checkbox, its own nesting and its own position, so a leading `-`,
// `#` or `>` has nothing left to describe.
//
// Only block syntax that is a *line prefix* is removed. A fence, a table row or
// `---` is left alone: §2.1 renders those as literal source inside an item, so
// keeping them shows the user what they typed. The spec's "removed entirely"
// category is empty by choice, and this file does not add to it.
//
// Dropping the inline stripper also removed a ReDoS surface, which is worth
// knowing before anyone reintroduces one. It matched links and inline code with
// character classes that excluded the *opening* delimiters as well as the
// closing ones, so a run of unmatched `[` or `(` failed in O(1) per position
// instead of backtracking over the whole run — without that, note content
// (which a collaborator can write) drives quadratic matching. Any future
// regex-based scan of item text needs the same care.

const LIST_MARKER_RE = /^(?:[-*+]|\d+\.)\s+(?:\[([ xX])\]\s*)?/;
const BLOCKQUOTE_RE = /^(?:>\s*)+/;
const HEADING_RE = /^#{1,6}\s+/;
const LEADING_WHITESPACE_RE = /^[ \t]*/;

/** A tab advances to the next 4-column stop, as in CommonMark. */
const TAB_WIDTH = 4;
/** Columns of indent that make a list line a child of the item above it. */
const NESTED_INDENT_COLUMNS = 2;

export interface ConvertedListItem {
  text: string;
  completed: boolean;
  /**
   * 0 for a top-level item, 1 for one nested under the nearest preceding
   * top-level item. This is the same encoding as
   * `CreateNoteItemRequest.indent_level`, which is what the server rebuilds
   * `parent_id` from on the bulk-create and convert paths; the model allows a
   * single level, so it never exceeds 1.
   */
  indentLevel: 0 | 1;
}

function indentColumns(prefix: string): number {
  let columns = 0;
  for (const ch of prefix) {
    columns += ch === '\t' ? TAB_WIDTH - (columns % TAB_WIDTH) : 1;
  }
  return columns;
}

/**
 * Parses one line of text-note content into a list item: strips the block
 * markdown an item structurally replaces — a leading list/checkbox marker
 * (recording completed state), blockquote markers and a heading prefix — and
 * records how deep the line was indented. Inline formatting is left as typed.
 * Returns null for a line that is blank once stripped.
 */
export function parseTextLineAsListItem(rawLine: string): ConvertedListItem | null {
  const leading = LEADING_WHITESPACE_RE.exec(rawLine)?.[0] ?? '';
  const indent = indentColumns(leading);
  // Only the *leading* whitespace comes off up front. Trailing whitespace has to
  // survive until the marker has been matched, because the marker regex needs the
  // space after the bullet: trimming both ends first turns a line holding nothing
  // but a bullet ("- ", "1. ") into an item reading "-" or "1.". The text is
  // trimmed at the end instead, once the prefixes are gone.
  let line = rawLine.slice(leading.length);
  if (!line.trim()) return null;

  let completed = false;
  let indentLevel: 0 | 1 = 0;

  // Blockquote markers are stripped on *both* sides of the list marker, because
  // the two nest in either order and an item replaces both: `> - [x] a` is a
  // quoted checklist, `- > a` a quote inside a list item. Stripping only before
  // the marker would leave the `>` in the second; only after (as this did
  // originally) leaves `- [x]` in the item text of the first — and that one also
  // loses the completed state, then renders a literal `- [x]` next to the item's
  // own real checkbox, which is the exact outcome §2.1 exists to prevent.
  line = line.replace(BLOCKQUOTE_RE, '');

  const listMatch = line.match(LIST_MARKER_RE);
  if (listMatch) {
    line = line.slice(listMatch[0].length);
    if (listMatch[1]) completed = listMatch[1].toLowerCase() === 'x';
    // Indent carries across only on a *list* line. An indented plain line is far
    // more often the wrapped continuation of the paragraph above it than a
    // deliberate child, and silently re-parenting it would be a worse surprise
    // than losing nesting the user never asked for. An indented list line is
    // unambiguous, and is exactly what listToText emits for a nested item.
    if (indent >= NESTED_INDENT_COLUMNS) indentLevel = 1;
  }

  line = line.replace(BLOCKQUOTE_RE, '').replace(HEADING_RE, '').trim();

  return line ? { text: line, completed, indentLevel } : null;
}

/**
 * Converts text-note content into list items, one per non-blank line, each
 * carrying the indent level the caller should send as `indent_level`.
 */
export function textToListItems(content: string): ConvertedListItem[] {
  return content
    .split('\n')
    .map(parseTextLineAsListItem)
    .filter((item): item is ConvertedListItem => item !== null);
}

/**
 * Renders a list note's title and items back into text-note content. The
 * title (if any) becomes an h1 line; items become a markdown task list, with
 * one level of indentation for items nested under a top-level item.
 *
 * Item text is emitted verbatim and deliberately **not** escaped. Items render
 * the inline Markdown subset themselves (docs/specs/markdown-rendering.md §2.1),
 * so the source that showed as bold in the item shows as bold in the converted
 * note; escaping would *introduce* a rendering change rather than prevent one.
 * Block syntax in item text needs no escaping either, because every item is
 * emitted behind a `- [ ] ` marker — a `#` or `---` stays inside a list item and
 * stays literal, exactly as the item rendered it.
 */
export function listToText(
  title: string,
  items: Pick<NoteItem, 'id' | 'text' | 'completed' | 'position' | 'parent_id'>[],
): string {
  const lines: string[] = [];
  const trimmedTitle = title.trim();
  if (trimmedTitle) {
    lines.push(`# ${trimmedTitle}`, '');
  }

  const childrenByParent = new Map<string, typeof items>();
  for (const item of items) {
    if (!item.parent_id) continue;
    const siblings = childrenByParent.get(item.parent_id) ?? [];
    siblings.push(item);
    childrenByParent.set(item.parent_id, siblings);
  }

  const topLevel = items.filter((item) => !item.parent_id).sort((a, b) => a.position - b.position);

  for (const parent of topLevel) {
    lines.push(renderItemLine(parent, 0));
    const children = (childrenByParent.get(parent.id) ?? []).sort((a, b) => a.position - b.position);
    for (const child of children) {
      lines.push(renderItemLine(child, 1));
    }
  }

  return lines.join('\n');
}

function renderItemLine(item: Pick<NoteItem, 'text' | 'completed'>, depth: number): string {
  const indent = '  '.repeat(depth);
  const box = item.completed ? '[x]' : '[ ]';
  return `${indent}- ${box} ${item.text}`;
}
