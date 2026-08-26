import type { TFunction } from 'i18next';
import type { NoteSort } from '@jot/shared';

const getEnglishSortLabel = (sortMode: NoteSort): string => {
  switch (sortMode) {
    case 'updated_at':
      return 'Last modified';
    case 'created_at':
      return 'Date created';
    case 'manual':
    default:
      return 'Manual';
  }
};

export const getNoteSortLabel = (
  sortMode: NoteSort,
  translate?: TFunction,
): string => {
  if (translate) {
    return translate(`dashboard.sortOption.${sortMode}`);
  }

  return getEnglishSortLabel(sortMode);
};
