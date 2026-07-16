import api from './client';
import { Platform } from 'react-native';
import type {
  Note,
  NoteItem,
  GetNotesParams,
  CreateNoteRequest,
  UpdateNoteRequest,
  ConvertNoteTypeRequest,
  CreateNoteItemRequest,
  PatchNoteItemRequest,
  EmptyTrashResponse,
  ImportResponse,
} from '@jot/shared';

function stripClientOnlyParams(params: GetNotesParams): Omit<GetNotesParams, 'user_id'> {
  const { archived, search, trashed, label, my_tasks } = params;
  return { archived, search, trashed, label, my_tasks };
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

export async function convertNoteType(id: string, data: ConvertNoteTypeRequest): Promise<Note> {
  const res = await api.post(`/notes/${id}/convert`, data);
  return res.data;
}

export async function createNoteItem(noteId: string, data: CreateNoteItemRequest): Promise<NoteItem> {
  const res = await api.post(`/notes/${noteId}/items`, data);
  return res.data;
}

export async function updateNoteItem(noteId: string, itemId: string, data: PatchNoteItemRequest): Promise<NoteItem> {
  const res = await api.patch(`/notes/${noteId}/items/${itemId}`, data);
  return res.data;
}

export async function deleteNoteItem(noteId: string, itemId: string): Promise<void> {
  await api.delete(`/notes/${noteId}/items/${itemId}`);
}

export async function reorderNoteItems(noteId: string, itemIds: string[]): Promise<void> {
  await api.post(`/notes/${noteId}/items/reorder`, { item_ids: itemIds });
}

export async function toggleItemCompleted(noteId: string, itemId: string, completed: boolean): Promise<NoteItem[]> {
  const res = await api.post(`/notes/${noteId}/items/${itemId}/toggle-completed`, { completed });
  return res.data;
}

// Bulk operations over an explicit set of item IDs, mirroring the webapp's
// setItemsCompleted/deleteItems. The caller passes the exact completed-item
// ids it captured at action time; each is one atomic server request that
// returns the note's item list for reconciliation.
export async function uncheckAllItems(noteId: string, itemIds: string[]): Promise<NoteItem[]> {
  const res = await api.post(`/notes/${noteId}/items/set-completed`, { item_ids: itemIds, completed: false });
  return res.data;
}

export async function deleteCompletedItems(noteId: string, itemIds: string[]): Promise<NoteItem[]> {
  const res = await api.post(`/notes/${noteId}/items/delete`, { item_ids: itemIds });
  return res.data;
}

export async function restoreNote(id: string): Promise<void> {
  await api.post(`/notes/${id}/restore`);
}

export async function duplicateNote(id: string, clientId?: string, itemIds?: Record<string, string>): Promise<Note> {
  const body: Record<string, unknown> = {};
  if (clientId) body.id = clientId;
  if (itemIds) body.item_ids = itemIds;
  const res = await api.post(`/notes/${id}/duplicate`, Object.keys(body).length ? body : undefined);
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
