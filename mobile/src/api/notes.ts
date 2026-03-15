import api from './client';
import { Note, GetNotesParams, CreateNoteRequest, UpdateNoteRequest } from '../types';

export async function getNotes(params?: GetNotesParams): Promise<Note[]> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { user_id, ...serverParams } = params ?? {};
  const res = await api.get('/notes', { params: params ? serverParams : undefined });
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
  const res = await api.put(`/notes/${id}`, data);
  return res.data;
}

export async function deleteNote(id: string): Promise<void> {
  await api.delete(`/notes/${id}`);
}

export async function restoreNote(id: string): Promise<void> {
  await api.post(`/notes/${id}/restore`);
}

export async function permanentDeleteNote(id: string): Promise<void> {
  await api.delete(`/notes/${id}/permanent`);
}

export async function reorderNotes(noteIds: string[]): Promise<void> {
  await api.post('/notes/reorder', { note_ids: noteIds });
}
