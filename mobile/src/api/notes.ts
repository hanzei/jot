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
} from '@jot/shared';
import { jot } from './jot';

export async function getNotes(params?: GetNotesParams): Promise<Note[]> {
  return jot.notes.getAll(params);
}

export async function getNote(id: string): Promise<Note> {
  return jot.notes.getById(id);
}

export async function createNote(data: CreateNoteRequest): Promise<Note> {
  return jot.notes.create(data);
}

export async function updateNote(id: string, data: UpdateNoteRequest): Promise<Note> {
  return jot.notes.update(id, data);
}

export async function deleteNote(id: string): Promise<void> {
  return jot.notes.delete(id);
}

export async function permanentDeleteNote(id: string): Promise<void> {
  return jot.notes.delete(id, { permanent: true });
}

export async function convertNoteType(id: string, data: ConvertNoteTypeRequest): Promise<Note> {
  return jot.notes.convert(id, data);
}

export async function createNoteItem(noteId: string, data: CreateNoteItemRequest): Promise<NoteItem> {
  return jot.notes.createItem(noteId, data);
}

export async function updateNoteItem(noteId: string, itemId: string, data: PatchNoteItemRequest): Promise<NoteItem> {
  return jot.notes.updateItem(noteId, itemId, data);
}

export async function deleteNoteItem(noteId: string, itemId: string): Promise<void> {
  return jot.notes.deleteItem(noteId, itemId);
}

export async function reorderNoteItems(noteId: string, itemIds: string[]): Promise<void> {
  return jot.notes.reorderItems(noteId, itemIds);
}

export async function toggleItemCompleted(noteId: string, itemId: string, completed: boolean): Promise<NoteItem[]> {
  return jot.notes.toggleItemCompleted(noteId, itemId, completed);
}

// Bulk operations over an explicit set of item IDs. The caller passes the
// exact item ids it captured at action time; each is one atomic server request
// that returns the note's item list for reconciliation.
export async function setItemsCompleted(noteId: string, itemIds: string[], completed: boolean): Promise<NoteItem[]> {
  return jot.notes.setItemsCompleted(noteId, itemIds, completed);
}

export async function deleteCompletedItems(noteId: string, itemIds: string[]): Promise<NoteItem[]> {
  return jot.notes.deleteItems(noteId, itemIds);
}

export async function markNoteViewed(id: string): Promise<void> {
  return jot.notes.markViewed(id);
}

export async function restoreNote(id: string): Promise<Note> {
  return jot.notes.restore(id);
}

export async function duplicateNote(id: string, clientId?: string, itemIds?: Record<string, string>): Promise<Note> {
  return jot.notes.duplicate(id, { id: clientId, itemIds });
}

export async function emptyTrash(): Promise<EmptyTrashResponse> {
  return jot.notes.emptyTrash();
}

export async function reorderNotes(noteIds: string[]): Promise<void> {
  return jot.notes.reorder(noteIds);
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

  return jot.notes.import(formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
}
