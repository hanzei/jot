import type { User, NoteShare, UserSettings, UserSearchResponse } from '@jot/shared';
import { jot } from './jot';

/** Every user but the caller; the server does not cap a listing without a search term. */
export async function getUsers(): Promise<User[]> {
  return jot.users.list();
}

/** At most 50 matches; `truncated` is set when more users matched the query. */
export async function searchUsers(query: string): Promise<UserSearchResponse> {
  return jot.users.search(query);
}

export async function shareNote(noteId: string, userId: string): Promise<void> {
  return jot.notes.share(noteId, { user_id: userId });
}

export async function unshareNote(noteId: string, userId: string): Promise<void> {
  return jot.notes.unshare(noteId, userId);
}

export async function getNoteShares(noteId: string): Promise<NoteShare[]> {
  return jot.notes.getShares(noteId);
}

export async function getSettings(): Promise<UserSettings> {
  return jot.users.getSettings();
}
