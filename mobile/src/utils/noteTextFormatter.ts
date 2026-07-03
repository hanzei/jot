import type { Note, NoteType } from '@jot/shared';
import type { LocalItem } from '../screens/noteEditor/listItemModel';

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*{3}([^*\n]+)\*{3}/g, '$1')
    .replace(/_{3}([^_\n]+)_{3}/g, '$1')
    .replace(/\*{2}([^*\n]+)\*{2}/g, '$1')
    .replace(/_{2}([^_\n]+)_{2}/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .trim();
}

interface TreeItem {
  id: string;
  text: string;
  completed: boolean;
  parentId: string | null;
  position: number;
}

function renderItemLines(items: TreeItem[], parentId: string | null = null, depth = 0): string[] {
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  const siblings = items
    .filter((i) => i.parentId === parentId)
    .sort((a, b) => a.position - b.position);
  for (const item of siblings) {
    lines.push(`${indent}${item.completed ? '[x]' : '[ ]'} ${item.text}`);
    lines.push(...renderItemLines(items, item.id, depth + 1));
  }
  return lines;
}

/**
 * Format the current editor state (live, possibly unsaved) as a shareable plain-text string.
 * Text notes: markdown formatting stripped. List notes: `[ ] / [x]` checkbox lines.
 */
export function formatEditorStateForShare(
  noteType: NoteType,
  title: string,
  content: string,
  items: LocalItem[],
): string {
  if (noteType === 'text') {
    return stripMarkdown(content);
  }
  const parts: string[] = [];
  const trimmedTitle = title.trim();
  if (trimmedTitle) parts.push(trimmedTitle);
  const treeItems: TreeItem[] = items.map((i) => ({
    id: i.id,
    text: i.text,
    completed: i.completed,
    parentId: i.parentId,
    position: i.position,
  }));
  const itemLines = renderItemLines(treeItems);
  if (itemLines.length > 0) parts.push(itemLines.join('\n'));
  return parts.join('\n\n');
}

/**
 * Format a server Note object as a shareable plain-text string.
 * Used when sharing from the note context menu where only the Note object is available.
 */
export function formatNoteForShare(note: Note): string {
  if (note.note_type === 'text') {
    return stripMarkdown(note.content);
  }
  const parts: string[] = [];
  const trimmedTitle = note.title.trim();
  if (trimmedTitle) parts.push(trimmedTitle);
  const treeItems: TreeItem[] = (note.items ?? []).map((i) => ({
    id: i.id,
    text: i.text,
    completed: i.completed,
    parentId: i.parent_id,
    position: i.position,
  }));
  const itemLines = renderItemLines(treeItems);
  if (itemLines.length > 0) parts.push(itemLines.join('\n'));
  return parts.join('\n\n');
}
