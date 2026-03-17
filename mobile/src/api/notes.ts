import api from './client';
import type { Note, GetNotesParams, CreateNoteRequest, UpdateNoteRequest } from '@jot/shared';

function stripClientOnlyParams(params: GetNotesParams): Omit<GetNotesParams, 'user_id'> {
  const { archived, search, trashed, label, my_todo } = params;
  return { archived, search, trashed, label, my_todo };
}

export async function getNotes(params?: GetNotesParams): Promise<Note[]> {
  const res = await api.get('/notes', { params: params ? stripClientOnlyParams(params) : undefined });
  return res.data;
}

export async function getNote(id: string): Promise<Note> {
  const res = await api.get(`/notes/${id}`);
  return res.data;
}

export async function createNote(data: CreateNoteRequest): Promise<Note> {
  const res = await api.post('/notes', data);
  return res.data;
}

export async function updateNote(id: string, data: UpdateNoteRequest): Promise<Note> {
  const res = await api.patch(`/notes/${id}`, data);
  return res.data;
}

export async function deleteNote(id: string): Promise<void> {
  await api.delete(`/notes/${id}`);
}

export async function restoreNote(id: string): Promise<void> {
  await api.post(`/notes/${id}/restore`);
}

export async function permanentDeleteNote(id: string): Promise<void> {
  await api.delete(`/notes/${id}`, { params: { permanent: true } });
}

export async function reorderNotes(noteIds: string[]): Promise<void> {
  await api.post('/notes/reorder', { note_ids: noteIds });
}
