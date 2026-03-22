import api from './client';
import type { UserInfo, PaginatedUsersResponse, NoteShare, UserSettings } from '@jot/shared';
import { collectAllPages } from './pagination';

export async function getUsers(): Promise<UserInfo[]> {
  return collectAllPages<UserInfo>(async (page) => {
    const res = await api.get('/users', { params: page });
    return res.data as PaginatedUsersResponse;
  });
}

export async function searchUsers(query: string): Promise<UserInfo[]> {
  return collectAllPages<UserInfo>(async (page) => {
    const res = await api.get('/users', { params: { search: query, ...page } });
    return res.data as PaginatedUsersResponse;
  });
}

export async function shareNote(noteId: string, userId: string): Promise<void> {
  await api.post(`/notes/${noteId}/share`, { user_id: userId });
}

export async function unshareNote(noteId: string, userId: string): Promise<void> {
  await api.delete(`/notes/${noteId}/shares/${userId}`);
}

export async function getNoteShares(noteId: string): Promise<NoteShare[]> {
  const res = await api.get(`/notes/${noteId}/shares`);
  return res.data;
}

export async function getSettings(): Promise<UserSettings> {
  const res = await api.get('/users/me/settings');
  return res.data;
}
