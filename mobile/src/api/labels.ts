import api from './client';
import type { Label, LabelListResponse, LabelWithCount, Note } from '@jot/shared';

export async function getLabels(): Promise<LabelWithCount[]> {
  const res = await api.get<LabelListResponse>('/labels');
  return res.data.labels;
}

export async function createLabel(name: string): Promise<Label> {
  const res = await api.post('/labels', { name });
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
