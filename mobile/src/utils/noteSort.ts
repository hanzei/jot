import type { TFunction } from 'i18next';
import type { NoteSort } from '@jot/shared';

export const getNoteSortLabel = (
  sortMode: NoteSort,
  translate: TFunction,
): string => translate(`dashboard.sortOption.${sortMode}`);
