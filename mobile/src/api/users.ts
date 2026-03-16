import api from './client';
import { User, NoteShare, UserSettings, UpdateSettingsRequest } from '../types';

export async function getUsers(): Promise<User[]> {
  const res = await api.get('/users');
  return res.data;
}

export async function searchUsers(query: string): Promise<User[]> {
  const res = await api.get('/users', { params: { search: query } });
  return res.data;
}

export async function shareNote(noteId: string, userId: string): Promise<void> {
  await api.post(`/notes/${noteId}/share`, { user_id: userId });
}

export async function unshareNote(noteId: string, userId: string): Promise<void> {
  await api.delete(`/notes/${noteId}/share`, { data: { user_id: userId } });
}

export async function getNoteShares(noteId: string): Promise<NoteShare[]> {
  const res = await api.get(`/notes/${noteId}/shares`);
  return res.data;
}

export async function getSettings(): Promise<UserSettings> {
  const res = await api.get('/users/me/settings');
  return res.data;
}

export async function updateSettings(data: UpdateSettingsRequest): Promise<UserSettings> {
  const res = await api.put('/users/me/settings', data);
  return res.data;
}
