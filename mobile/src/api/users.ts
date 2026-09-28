import api from './client';
import type { User, NoteShare, UserSettings, UserSearchResponse, NoteShareListResponse } from '@jot/shared';

/** Every user but the caller; the server does not cap a listing without a search term. */
export async function getUsers(): Promise<User[]> {
  const res = await api.get<UserSearchResponse>('/users');
  return res.data.users;
}

/** At most 50 matches; the server sets `truncated` on the response when there were more. */
export async function searchUsers(query: string): Promise<User[]> {
  const res = await api.get<UserSearchResponse>('/users', { params: { search: query } });
  return res.data.users;
}

export async function shareNote(noteId: string, userId: string): Promise<void> {
  await api.post(`/notes/${noteId}/share`, { user_id: userId });
}

export async function unshareNote(noteId: string, userId: string): Promise<void> {
  await api.delete(`/notes/${noteId}/shares/${userId}`);
}

export async function getNoteShares(noteId: string): Promise<NoteShare[]> {
  const res = await api.get<NoteShareListResponse>(`/notes/${noteId}/shares`);
  return res.data.shares;
}

export async function getSettings(): Promise<UserSettings> {
  const res = await api.get('/users/me/settings');
  return res.data;
}
