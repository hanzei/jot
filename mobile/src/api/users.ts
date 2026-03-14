import api from './client';
import { User, NoteShare } from '../types';

export async function searchUsers(query: string): Promise<User[]> {
  const res = await api.get('/users', { params: { search: query } });
  return res.data;
}

export async function shareNote(noteId: string, username: string): Promise<void> {
  await api.post(`/notes/${noteId}/share`, { username });
}

export async function unshareNote(noteId: string, username: string): Promise<void> {
  await api.delete(`/notes/${noteId}/share`, { data: { username } });
}

export async function getNoteShares(noteId: string): Promise<NoteShare[]> {
  const res = await api.get(`/notes/${noteId}/shares`);
  return res.data;
}
