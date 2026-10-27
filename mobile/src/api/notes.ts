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
  FileImportType,
  ImportResponse,
  NoteListResponse,
  NoteRevision,
  NoteRevisionListResponse,
  NoteRevisionSummary,
  RestoreNoteRevisionRequest,
} from '@jot/shared';

function stripClientOnlyParams(params: GetNotesParams): Omit<GetNotesParams, 'user_id'> {
  const { archived, search, trashed, label, my_tasks } = params;
  return { archived, search, trashed, label, my_tasks };
}

export async function getNotes(params?: GetNotesParams): Promise<Note[]> {
  const res = await api.get<NoteListResponse>('/notes', { params: params ? stripClientOnlyParams(params) : undefined });
  return res.data.notes;
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

export async function markNoteViewed(id: string): Promise<void> {
  await api.post(`/notes/${id}/viewed`);
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

// Note history is online-only: revisions are never cached locally, and a
// restore has no queue to fall back on (mobile-connectivity-handling.md §4.3).

export async function getNoteRevisions(noteId: string): Promise<NoteRevisionSummary[]> {
  const res = await api.get<NoteRevisionListResponse>(`/notes/${noteId}/revisions`);
  return res.data.revisions;
}

export async function getNoteRevision(noteId: string, revisionId: string): Promise<NoteRevision> {
  const res = await api.get<NoteRevision>(`/notes/${noteId}/revisions/${revisionId}`);
  return res.data;
}

/**
 * Timeout for a restore. It is a one-shot op with no offline queue behind it,
 * so it gets a read-sized budget instead of the short write one; the request
 * interceptor only shortens a POST left at the default, hence its own value.
 */
export const RESTORE_REVISION_TIMEOUT_MS = 20000;

export async function restoreNoteRevision(noteId: string, revisionId: string, data: RestoreNoteRevisionRequest): Promise<Note> {
  const res = await api.post<Note>(`/notes/${noteId}/revisions/${revisionId}/restore`, data, {
    timeout: RESTORE_REVISION_TIMEOUT_MS,
  });
  return res.data;
}

export interface ImportFile {
  uri: string;
  name: string;
  mimeType?: string | null | undefined;
}

function inferMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.zip')) return 'application/zip';
  return 'application/json';
}

export async function importFile(file: ImportFile, importType: FileImportType): Promise<ImportResponse> {
  const formData = new FormData();
  formData.append('import_type', importType);
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
