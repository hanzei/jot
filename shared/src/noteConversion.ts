import type { NoteItem } from './types';

export interface ConvertedListItem {
  text: string;
  completed: boolean;
}

// Heuristic, line-oriented markdown stripping — not a full parser. It only
// needs to handle the syntax subset webapp/src/utils/markdown.ts renders
// (headings, bold/italic, inline code, links, blockquotes, lists).
const LIST_MARKER_RE = /^(?:[-*+]|\d+\.)\s+(?:\[([ xX])\]\s*)?/;
const BLOCKQUOTE_RE = /^(?:>\s*)+/;
const HEADING_RE = /^#{1,6}\s+/;
// Character classes exclude '[' and '(' too (not just the closing delimiter)
// so a run of unmatched opening delimiters (e.g. "[[[[[[") fails to match in
// O(1) per position instead of backtracking over the whole run — otherwise
// this is a quadratic-time ReDoS on attacker-controlled note content.
const LINK_RE = /\[([^[\]]*)\]\([^()]*\)/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
// Underscore emphasis requires word boundaries, matching marked/CommonMark:
// my_file_name is left alone, but __init__ still counts as emphasis.
const BOLD_RE = /\*\*(.+?)\*\*|(?<!\w)__(.+?)__(?!\w)/g;
const ITALIC_RE = /\*(.+?)\*|(?<!\w)_(.+?)_(?!\w)/g;

function stripInlineFormatting(text: string): string {
  return text
    .replace(LINK_RE, '$1')
    .replace(INLINE_CODE_RE, '$1')
    .replace(BOLD_RE, (_m, a: string | undefined, b: string | undefined) => a ?? b ?? '')
    .replace(ITALIC_RE, (_m, a: string | undefined, b: string | undefined) => a ?? b ?? '')
    .trim();
}

/**
 * Parses one line of text-note content into a list item: strips a leading
 * list/checkbox marker (recording completed state) and any inline markdown
 * formatting. Returns null for a line that is blank once stripped.
 */
export function parseTextLineAsListItem(rawLine: string): ConvertedListItem | null {
  let line = rawLine.trim();
  if (!line) return null;

  let completed = false;
  const listMatch = line.match(LIST_MARKER_RE);
  if (listMatch) {
    line = line.slice(listMatch[0].length);
    if (listMatch[1]) completed = listMatch[1].toLowerCase() === 'x';
  }

  line = line.replace(BLOCKQUOTE_RE, '').replace(HEADING_RE, '');
  line = stripInlineFormatting(line);

  return line ? { text: line, completed } : null;
}

/** Converts text-note content into a flat list of top-level list items. */
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
