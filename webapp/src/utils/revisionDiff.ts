// Comparisons for the note history panel: how a revision differs from the note
// as it is now. Pure, so it is tested on its own.
import { diffItems, itemSnapshot, listToText, type ItemSnapshot, type NoteRevision, type NoteType } from '@jot/shared';
import { normalizeItemOrder, type ListItem } from '@/utils/noteItems';
import { diffLines, type DiffLine } from '@/utils/lineDiff';

/** The note's shared content as the editor holds it now. */
export interface CurrentNoteContent {
  noteType: NoteType;
  title: string;
  content: string;
  items: ListItem[];
}

/**
 * One way a list item differs between a revision and the current note.
 * `removed` items exist only in the revision; every other kind describes the
 * item as it is now.
 */
export type ItemChange =
  | { kind: 'removed' | 'added' | 'checked' | 'unchecked' | 'moved' | 'reassigned'; text: string }
  | { kind: 'edited'; before: string; after: string }
  | { kind: 'reordered' };

export type RevisionComparison =
  // Same type on both sides: a list compares item by item, a text note by line.
  | { kind: 'list'; titleBefore: string; titleAfter: string; changes: ItemChange[] }
  | { kind: 'text'; lines: DiffLine[] }
  // The types differ: both sides compared as text, the list rendered the way a
  // conversion would write it.
  | { kind: 'converted'; revisionType: NoteType; lines: DiffLine[] };

/** A revision's items as editor list items, in display order. */
export const revisionListItems = (revision: Pick<NoteRevision, 'items'>): ListItem[] =>
  normalizeItemOrder(revision.items.map(item => ({
    id: item.id,
    text: item.text,
    completed: item.completed,
    position: item.position,
    parentId: item.parent_id,
    assigned_to: item.assigned_to,
  })));

const asText = (noteType: NoteType, title: string, content: string, items: ListItem[]): string =>
  noteType === 'list'
    ? listToText(title, items.map(item => ({ ...item, parent_id: item.parentId })))
    : content;

/**
 * Changes from `revisionItems` to `currentItems`, built from the same diff the
 * autosave engine uses: the revision plays the saved baseline and the current
 * items the edited state.
 */
export function compareItems(revisionItems: ListItem[], currentItems: ListItem[]): ItemChange[] {
  const baseline = new Map<string, ItemSnapshot>(revisionItems.map(item => [item.id, itemSnapshot(item)]));
  const changes: ItemChange[] = [];
  for (const op of diffItems(baseline, revisionItems.map(item => item.id), currentItems)) {
    if (op.kind === 'create') {
      changes.push({ kind: 'added', text: op.snapshot.text });
    } else if (op.kind === 'delete') {
      changes.push({ kind: 'removed', text: baseline.get(op.itemId)?.text ?? '' });
    } else if (op.kind === 'reorder') {
      changes.push({ kind: 'reordered' });
    } else {
      const before = baseline.get(op.itemId)?.text ?? '';
      const text = op.snapshot.text;
      if (op.patch.text !== undefined) changes.push({ kind: 'edited', before, after: text });
      if (op.patch.completed !== undefined) changes.push({ kind: op.patch.completed ? 'checked' : 'unchecked', text });
      if (op.patch.parent_id !== undefined) changes.push({ kind: 'moved', text });
      if (op.patch.assigned_to !== undefined) changes.push({ kind: 'reassigned', text });
    }
  }
  return changes;
}

/** How `revision` differs from `current`. */
export function compareRevision(revision: NoteRevision, current: CurrentNoteContent): RevisionComparison {
  const revisionItems = revisionListItems(revision);
  if (revision.note_type !== current.noteType) {
    return {
      kind: 'converted',
      revisionType: revision.note_type,
      lines: diffLines(
        asText(revision.note_type, revision.title, revision.content, revisionItems),
        asText(current.noteType, current.title, current.content, current.items),
      ),
    };
  }
  if (revision.note_type === 'list') {
    return {
      kind: 'list',
      titleBefore: revision.title,
      titleAfter: current.title,
      changes: compareItems(revisionItems, current.items),
    };
  }
  return { kind: 'text', lines: diffLines(revision.content, current.content) };
}

/** Whether `comparison` found no difference at all. */
export const isUnchanged = (comparison: RevisionComparison): boolean =>
  comparison.kind === 'list'
    ? comparison.titleBefore === comparison.titleAfter && comparison.changes.length === 0
    : comparison.kind === 'text' && comparison.lines.every(line => line.kind === 'same');
