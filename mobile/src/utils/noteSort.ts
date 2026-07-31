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
  translate?: (key: string, options?: Record<string, unknown>) => string,
): string => {
  if (translate) {
    return translate(`dashboard.sortOption.${sortMode}`);
  }

  return getEnglishSortLabel(sortMode);
};
