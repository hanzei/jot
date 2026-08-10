// Pure item-model helpers for the note editor's list items.
//
// Everything here takes plain data and returns plain data, with no React and no
// API access, so the indent/reorder/cascade rules can be unit-tested without
// rendering a modal. NoteModal is the only consumer today; it holds the state
// these operate on and persists whatever they return.

export interface ListItem {
  id: string;
  text: string;
  completed: boolean;
  position: number;
  // The item this one is nested under, or null for a top-level item. Source of
  // truth for grouping; the one-level indent shown in the UI is derived from it
  // via indentOf(). Replaces the former indentLevel field.
  parentId: string | null;
  assignedTo: string;
}

// The DOM id of a row's textarea. Derived from the item id (22 random
// alphanumerics, so always a valid id) rather than useId, because NoteModal has
// to name the focused row's field from outside the row — that is what the
// list-note formatting toolbar points aria-controls at.
export const itemTextareaId = (itemId: string): string => `list-item-text-${itemId}`;

// indentOf derives the render indent (0 = top-level, 1 = nested) from parentId.
// Nesting is capped at one level, so a child is always exactly one level in.
export const indentOf = (item: { parentId: string | null }): number => (item.parentId ? 1 : 0);

// normalizeItemOrder is the single source of item ordering. It walks top-level
// items in their current order and emits each immediately followed by its
// children (so a group is always contiguous), promotes any orphaned child whose
// parent no longer exists to top-level, then assigns position = 0..N across the
// whole set. Calling it after every structural mutation keeps each group intact
// and keeps a checked item's slot relative to its neighbours, so unchecking
// lands it back where it belongs even after items above were added or removed.
export const normalizeItemOrder = (items: ListItem[]): ListItem[] => {
  const childrenByParent = new Map<string, ListItem[]>();
  for (const it of items) {
    if (it.parentId !== null) {
      const siblings = childrenByParent.get(it.parentId) ?? [];
      siblings.push(it);
      childrenByParent.set(it.parentId, siblings);
    }
  }

  const ordered: ListItem[] = [];
  const placed = new Set<string>();
  for (const it of items) {
    if (it.parentId !== null) continue; // children are emitted under their parent
    ordered.push(it);
    placed.add(it.id);
    for (const child of childrenByParent.get(it.id) ?? []) {
      ordered.push(child);
      placed.add(child.id);
    }
  }
  // Any item not placed is an orphan (its parent is missing or is itself a
  // child); promote it to top-level so it is never dropped.
  for (const it of items) {
    if (!placed.has(it.id)) ordered.push({ ...it, parentId: null });
  }

  return ordered.map((it, index) => ({ ...it, position: index }));
};

// itemHasChildren reports whether any item is nested under itemId. Indenting an
// item that has children would create grandchildren, which the server rejects
// (nesting is capped at one level), so callers must refuse it.
export const itemHasChildren = (items: ListItem[], itemId: string): boolean =>
  items.some(it => it.parentId === itemId);

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

// dropTargetParentId decides which group a vertically-dragged item joins, based
// on where it landed in the freshly-moved (not yet normalized) array. This is
// what lets an item be dragged from one group into another:
//   - a parent (item with children) can't become a child, so it stays top-level;
//   - dropped right after a child → joins that child's group (same parent);
//   - dropped between a top-level item and its first child → becomes that item's
//     first child (joins/forms the group);
//   - otherwise → a top-level item.
export const dropTargetParentId = (items: ListItem[], index: number, draggedId: string): string | null => {
  if (itemHasChildren(items, draggedId)) return null;
  const prev = items[index - 1];
  if (!prev) return null; // dropped at the very top of the list
  if (prev.parentId !== null) return prev.parentId; // dropped inside prev's group
  const next = items[index + 1];
  if (next && next.parentId === prev.id) return prev.id; // dropped as prev's first child
  return null; // a top-level sibling after prev
};

// applyCompletedCascade mirrors the server's cascade locally: a top-level
// item's completed state cascades to all of its children (in either
// direction), while unchecking a child also un-completes its parent — a
// parent can never stay "done" with an incomplete child. Completing every
// child does not auto-complete the parent; that still requires checking it.
export const applyCompletedCascade = (items: ListItem[], itemId: string, completed: boolean): ListItem[] => {
  const target = items.find(item => item.id === itemId);
  if (!target) return items;
  const cascadeToChildren = target.parentId === null;
  const uncompleteParent = target.parentId !== null && !completed;
  return items.map(item => {
    if (item.id === itemId) return { ...item, completed };
    if (cascadeToChildren && item.parentId === itemId) return { ...item, completed };
    if (uncompleteParent && item.id === target.parentId) return { ...item, completed: false };
    return item;
  });
};
