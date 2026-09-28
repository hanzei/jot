import { blockNodesToPlainText, listToPlainText, type NoteType } from '@jot/shared';
import type { LocalItem } from '../screens/noteEditor/listItemModel';
import { blockMarkdownNodes } from './markdown';

/**
 * Format the current editor state (live, possibly unsaved) as a shareable plain-text string.
 * Text notes: the parsed Markdown as plain text (`blockNodesToPlainText`); they have no title.
 * List notes: title, then `[ ] / [x]` checkbox lines (`listToPlainText`).
 */
export function formatEditorStateForShare(
  noteType: NoteType,
  title: string,
  content: string,
  items: LocalItem[],
): string {
  if (noteType === 'text') {
    return blockNodesToPlainText(blockMarkdownNodes(content));
  }
  return listToPlainText(
    title,
    items.map((i) => ({
      id: i.id,
      text: i.text,
      completed: i.completed,
      position: i.position,
      parent_id: i.parentId,
    })),
  );
}
