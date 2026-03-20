import type { Note, NoteSort } from '@jot/shared';

export const NOTE_SORT_OPTIONS: ReadonlyArray<NoteSort> = [
  'manual',
  'updated_at',
  'created_at',
];

export const normalizeNoteSort = (value?: string): NoteSort =>
  NOTE_SORT_OPTIONS.includes(value as NoteSort) ? (value as NoteSort) : 'manual';

export const compareDescendingTimestamps = (left: string, right: string): number => {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);

  if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) {
    return 0;
  }
  if (Number.isNaN(leftTime)) {
    return 1;
  }
  if (Number.isNaN(rightTime)) {
    return -1;
  }

  return rightTime - leftTime;
};

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

export const sortNotesForDisplay = (
  notes: Note[],
  sortMode: NoteSort,
): { pinned: Note[]; other: Note[] } => {
  const originalIndexById = new Map(notes.map((note, index) => [note.id, index]));
  const preserveOriginalOrder = (left: Note, right: Note): number =>
    (originalIndexById.get(left.id) ?? 0) - (originalIndexById.get(right.id) ?? 0);

  const compareWithinGroup = (left: Note, right: Note): number => {
    switch (sortMode) {
      case 'updated_at':
        return compareDescendingTimestamps(left.updated_at, right.updated_at) || preserveOriginalOrder(left, right);
      case 'created_at':
        return compareDescendingTimestamps(left.created_at, right.created_at) || preserveOriginalOrder(left, right);
      case 'manual':
      default:
        return preserveOriginalOrder(left, right);
    }
  };

  const sortGroup = (group: Note[]) => (sortMode === 'manual' ? group : [...group].sort(compareWithinGroup));
  const pinned = sortGroup(notes.filter(note => note.pinned));
  const other = sortGroup(notes.filter(note => !note.pinned));

  return { pinned, other };
};
