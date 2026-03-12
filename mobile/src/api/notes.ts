import { apiClient } from './client';
import type { Note, CreateNoteRequest, UpdateNoteRequest } from '../types';

export const getNotes = async (params?: {
  archived?: boolean;
  trashed?: boolean;
  search?: string;
  label?: string;
}): Promise<Note[]> => {
  const response = await apiClient.get<Note[]>('/notes', { params });
  return response.data;
};

export const getNote = async (id: string): Promise<Note> => {
  const response = await apiClient.get<Note>(`/notes/${id}`);
  return response.data;
};

export const createNote = async (data: CreateNoteRequest): Promise<Note> => {
  const response = await apiClient.post<Note>('/notes', data);
  return response.data;
};

export const updateNote = async (id: string, data: UpdateNoteRequest): Promise<Note> => {
  const response = await apiClient.put<Note>(`/notes/${id}`, data);
  return response.data;
};

export const deleteNote = async (id: string): Promise<void> => {
  await apiClient.delete(`/notes/${id}`);
};

export const restoreNote = async (id: string): Promise<Note> => {
  const response = await apiClient.post<Note>(`/notes/${id}/restore`);
  return response.data;
};

export const permanentlyDeleteNote = async (id: string): Promise<void> => {
  await apiClient.delete(`/notes/${id}/permanent`);
};

export const reorderNotes = async (noteIds: string[]): Promise<void> => {
  await apiClient.post('/notes/reorder', { note_ids: noteIds });
};

export const shareNote = async (id: string, username: string): Promise<void> => {
  await apiClient.post(`/notes/${id}/share`, { username });
};

export const unshareNote = async (id: string, username: string): Promise<void> => {
  await apiClient.delete(`/notes/${id}/share`, { data: { username } });
};

export const getNoteShares = async (id: string) => {
  const response = await apiClient.get(`/notes/${id}/shares`);
  return response.data;
};
