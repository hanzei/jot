import api from './client';
import type { Label } from '@jot/shared';

export async function getLabels(): Promise<Label[]> {
  const res = await api.get('/labels');
  return res.data;
}

export async function addLabelToNote(noteId: string, name: string): Promise<void> {
  await api.post(`/notes/${noteId}/labels`, { name });
}

export async function removeLabelFromNote(noteId: string, labelId: string): Promise<void> {
  await api.delete(`/notes/${noteId}/labels/${labelId}`);
}
