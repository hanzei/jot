import type { Label, Note } from '@jot/shared';
import { jot } from './jot';

export async function getLabels(): Promise<Label[]> {
  return jot.labels.getAll();
}

export async function getLabelCounts(): Promise<Record<string, number>> {
  return jot.labels.getCounts();
}

export async function createLabel(name: string): Promise<Label> {
  return jot.labels.create(name);
}

export async function addLabelToNote(noteId: string, name: string): Promise<Note> {
  return jot.notes.addLabel(noteId, name);
}

export async function removeLabelFromNote(noteId: string, labelId: string): Promise<Note> {
  return jot.notes.removeLabel(noteId, labelId);
}

export async function renameLabel(labelId: string, name: string): Promise<Label> {
  return jot.labels.rename(labelId, name);
}

export async function deleteLabel(labelId: string): Promise<void> {
  return jot.labels.delete(labelId);
}
