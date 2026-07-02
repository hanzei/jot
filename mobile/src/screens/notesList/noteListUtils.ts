import type { Note } from '@jot/shared';

export interface LocalReorderState {
  pinned: Note[] | null;
  unpinned: Note[] | null;
}

/** The fixed set of dashboard sections; a literal union so key checks (e.g. `key === 'pinned'`) are compile-time validated. */
export type NoteSectionKey = 'pinned' | 'other' | 'notes' | 'archived';

export type NoteSection = { key: NoteSectionKey; title: string | null; data: Note[] };

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
