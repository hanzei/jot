// Pure item-model helpers for a list note's checklist items, shared by the
// webapp and mobile note editors. Everything here takes plain data and
// returns plain data, so the ordering/cascade/drop-target rules can be
// unit-tested without rendering either editor, and so both clients apply
// exactly one implementation instead of hand-kept copies. Mirrors the
// server's authoritative behavior — cascadeItemCompletion in
// server/internal/models/note_store_items.go for the completed cascade, and
// the one-level nesting cap enforced there for parenting.

export interface ListItem {
  id: string;
  text: string;
  completed: boolean;
  position: number;
  /** The item this one is nested under, or null for a top-level item. */
  parentId: string | null;
  assigned_to: string;
}

// itemHasChildren reports whether any item is nested under itemId. Indenting
// an item that has children would create grandchildren, which the server
// rejects (nesting is capped at one level), so callers must refuse it.
export const itemHasChildren = (items: ListItem[], itemId: string): boolean =>
  items.some(it => it.parentId === itemId);

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

// groupNoteItems returns a list note's items (the API's NoteItem shape) in
// display order: by position, with each top-level item immediately followed by
// its children. For read-only views such as the note cards, which would
// otherwise show a child whose position sorts ahead of its parent's above that
// parent. The server keeps stored positions in this order, so this matters for
// data it has not normalized yet: a local edit mobile has not synced, or a
// response from a server that predates the rule. Unlike normalizeItemOrder it
// neither re-parents nor renumbers: a child whose parent is not a top-level
// item in the list keeps its own place, matching the server's
// groupedItemOrder.
export const groupNoteItems = <T extends { id: string; position: number; parent_id: string | null }>(
  items: readonly T[],
): T[] => {
  // Stable, so items sharing a position keep the order they arrived in (the
  // server's created_at, id tiebreak).
  const sorted = [...items].sort((a, b) => a.position - b.position);
  const topLevel = new Set<string>();
  for (const it of sorted) {
    if (it.parent_id === null) topLevel.add(it.id);
  }
  const isGrouped = (it: T): boolean => it.parent_id !== null && topLevel.has(it.parent_id);

  const childrenByParent = new Map<string, T[]>();
  for (const it of sorted) {
    if (it.parent_id === null || !isGrouped(it)) continue;
    const siblings = childrenByParent.get(it.parent_id) ?? [];
    siblings.push(it);
    childrenByParent.set(it.parent_id, siblings);
  }

  const ordered: T[] = [];
  for (const it of sorted) {
    if (isGrouped(it)) continue; // emitted under its parent
    ordered.push(it, ...(childrenByParent.get(it.id) ?? []));
  }
  return ordered;
};

// dropTargetParentId decides which group a vertically-dragged item joins,
// given the row it landed directly below (`above`, or null when dropped at
// the very top). This is what lets an item be dragged from one group into
// another:
//   - a parent (item with children) can't become a child, so it stays top-level;
//   - dropped right after a child → joins that child's group (same parent);
//   - dropped right after a childless top-level item that already has
//     children elsewhere in the list → becomes that item's child (joins the
//     group even though its other children aren't adjacent to this drop);
//   - otherwise → a top-level item.
// `allItems` backs both children checks and need not be normalized — the
// checks are keyed by id/parentId, not by position.
export const dropTargetParentId = (
  allItems: ListItem[],
  aboveItem: ListItem | null,
  draggedId: string,
): string | null => {
  if (itemHasChildren(allItems, draggedId)) return null;
  if (!aboveItem) return null; // dropped at the very top of the list
  if (aboveItem.parentId !== null) return aboveItem.parentId; // dropped inside above's group
  if (itemHasChildren(allItems, aboveItem.id)) return aboveItem.id; // dropped as above's child
  return null; // a top-level sibling after above
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
