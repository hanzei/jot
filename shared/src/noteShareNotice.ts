import type { Note, SSEEvent } from './types';
import { codePointLength, truncateToCodePoints } from './text';

/** How long the note title in a "shared with you" notice may get. */
export const SHARED_NOTE_TITLE_MAX_LENGTH = 40;

/**
 * Whether an SSE event is a note being shared *with* `currentUserId` by
 * someone else. `note_shared` goes to the note's whole audience; only the user
 * named by `target_user_id` is the new recipient. Servers that predate
 * `target_user_id` on `note_shared` never match, so those clients stay silent.
 */
export function isNoteSharedWithUser(event: SSEEvent, currentUserId: string | undefined): boolean {
  return (
    event.type === 'note_shared' &&
    !!currentUserId &&
    event.target_user_id === currentUserId &&
    event.source_user_id !== currentUserId
  );
}

/**
 * A one-line name for a note in a notice: a list's title, or a text note's
 * first non-empty line with any Markdown heading marker stripped, truncated to
 * `maxLength` code points. Empty when the note has nothing to show — callers
 * substitute their own "untitled" string.
 */
export function noteNoticeTitle(note: Note, maxLength: number = SHARED_NOTE_TITLE_MAX_LENGTH): string {
  let title: string;
  if (note.note_type === 'list') {
    title = note.title.trim();
  } else {
    const line = note.content.split('\n').find(l => l.trim() !== '') ?? '';
    title = line.trim().replace(/^#{1,6}\s+/, '');
  }
  if (codePointLength(title) <= maxLength) return title;
  return `${truncateToCodePoints(title, maxLength - 1).trimEnd()}…`;
}
