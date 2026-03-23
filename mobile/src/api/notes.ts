import api from './client';
import { Platform } from 'react-native';
import type {
  Note,
  GetNotesParams,
  CreateNoteRequest,
  UpdateNoteRequest,
  EmptyTrashResponse,
  ImportResponse,
} from '@jot/shared';

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

export async function duplicateNote(id: string): Promise<Note> {
  const res = await api.post(`/notes/${id}/duplicate`);
  return res.data;
}

export async function permanentDeleteNote(id: string): Promise<void> {
  await api.delete(`/notes/${id}`, { params: { permanent: true } });
}

export async function emptyTrash(): Promise<EmptyTrashResponse> {
  const res = await api.delete('/notes/trash');
  return res.data;
}

export async function reorderNotes(noteIds: string[]): Promise<void> {
  await api.post('/notes/reorder', { note_ids: noteIds });
}

export interface ImportFile {
  uri: string;
  name: string;
  mimeType?: string | null;
}

function inferMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.zip')) return 'application/zip';
  return 'application/json';
}

export async function importKeepFile(file: ImportFile): Promise<ImportResponse> {
  const formData = new FormData();
  formData.append('file', {
    uri: Platform.OS === 'ios' ? file.uri.replace('file://', '') : file.uri,
    name: file.name,
    type: file.mimeType || inferMimeType(file.name),
  } as unknown as Blob);

  const res = await api.post('/notes/import', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}
