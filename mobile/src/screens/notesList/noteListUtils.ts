import type { Note } from '@jot/shared';

export interface LocalReorderState {
  pinned: Note[] | null;
  unpinned: Note[] | null;
}

export type NoteSection = { key: string; title: string | null; data: Note[] };

export function buildNoteSections(
  displayPinned: Note[],
  displayUnpinned: Note[],
  displayedArchived: Note[],
  includePinned: boolean,
  t: (key: string) => string,
): NoteSection[] {
  const sections: NoteSection[] = [];
  if (includePinned && displayPinned.length > 0) {
    sections.push({ key: 'pinned', title: t('dashboard.pinned'), data: displayPinned });
  }
  if (displayUnpinned.length > 0) {
    sections.push({
      key: includePinned ? 'other' : 'notes',
      title: includePinned && displayPinned.length > 0 ? t('dashboard.otherNotes') : null,
      data: displayUnpinned,
    });
  }
  if (displayedArchived.length > 0) {
    sections.push({ key: 'archived', title: t('dashboard.archivedResults'), data: displayedArchived });
  }
  return sections;
}
