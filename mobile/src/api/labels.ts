import { apiClient } from './client';
import type { Label } from '../types';

export const getLabels = async (): Promise<Label[]> => {
  const response = await apiClient.get<Label[]>('/labels');
  return response.data;
};

export const addLabelToNote = async (noteId: string, labelId: string): Promise<void> => {
  await apiClient.post(`/notes/${noteId}/labels`, { label_id: labelId });
};

export const removeLabelFromNote = async (noteId: string, labelId: string): Promise<void> => {
  await apiClient.delete(`/notes/${noteId}/labels/${labelId}`);
};
