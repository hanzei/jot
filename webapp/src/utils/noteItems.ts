// Editor-only item-model helpers for the note editor's list items. The
// ordering/cascade/drop-target rules themselves live in `@jot/shared`
// (`listItems.ts`), shared with mobile; this file re-exports them alongside
// the webapp-specific helpers (DOM id, render indent, drag anchor lookup)
// that have no mobile equivalent.
//
// Everything here takes plain data and returns plain data, with no React and no
// API access, so the indent/reorder/cascade rules can be unit-tested without
// rendering a modal. NoteModal is the only consumer today; it holds the state
// these operate on and persists whatever they return.

export { applyCompletedCascade, dropTargetParentId, itemHasChildren, normalizeItemOrder, type ListItem } from '@jot/shared';
import type { ListItem } from '@jot/shared';

// The DOM id of a row's textarea. Derived from the item id (22 random
// alphanumerics, so always a valid id) rather than useId, because NoteModal has
// to name the focused row's field from outside the row — that is what the
// list-note formatting toolbar points aria-controls at.
export const itemTextareaId = (itemId: string): string => `list-item-text-${itemId}`;

// indentOf derives the render indent (0 = top-level, 1 = nested) from parentId.
// Nesting is capped at one level, so a child is always exactly one level in.
export const indentOf = (item: { parentId: string | null }): number => (item.parentId ? 1 : 0);

// precedingTopLevelId returns the id of the nearest top-level item before itemId
// in the (normalized) order, or null if there is none — i.e. the item an indent
// gesture should nest itemId under.
export const precedingTopLevelId = (items: ListItem[], itemId: string): string | null => {
  let last: string | null = null;
  for (const it of items) {
    if (it.id === itemId) return last;
    if (it.parentId === null) last = it.id;
  }
  return null;
};
