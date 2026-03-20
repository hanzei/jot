import api from './client';
import type { Label, Note } from '@jot/shared';

export async function getLabels(): Promise<Label[]> {
  const res = await api.get('/labels');
  return res.data;
}

export async function addLabelToNote(noteId: string, name: string): Promise<Note> {
  const res = await api.post(`/notes/${noteId}/labels`, { name });
  return res.data;
}

export async function removeLabelFromNote(noteId: string, labelId: string): Promise<Note> {
  const res = await api.delete(`/notes/${noteId}/labels/${labelId}`);
  return res.data;
}

export async function renameLabel(labelId: string, name: string): Promise<Label> {
  const res = await api.patch(`/labels/${labelId}`, { name });
  return res.data;
}

export async function deleteLabel(labelId: string): Promise<void> {
  await api.delete(`/labels/${labelId}`);
}
