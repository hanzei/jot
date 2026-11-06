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
export const itemHasChildren = (items: readonly ListItem[], itemId: string): boolean =>
  items.some(it => it.parentId === itemId);

// normalizeItemOrder is the single source of item ordering. It walks top-level
// items in their current order and emits each immediately followed by its
// children (so a group is always contiguous), promotes any orphaned child whose
// parent no longer exists to top-level, then assigns position = 0..N across the
// whole set. Calling it after every structural mutation keeps each group intact
// and keeps a checked item's slot relative to its neighbours, so unchecking
// lands it back where it belongs even after items above were added or removed.
export const normalizeItemOrder = (items: readonly ListItem[]): ListItem[] => {
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
// display order: by position, each top-level item immediately followed by its
// children. For read-only views such as the note cards. Unlike
// normalizeItemOrder it neither re-parents nor renumbers: a child whose parent
// is not a top-level item in the list keeps its own place, matching the
// server's groupedItemOrder.
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
  const isGrouped = (it: T): it is T & { parent_id: string } =>
    it.parent_id !== null && topLevel.has(it.parent_id);

  const childrenByParent = new Map<string, T[]>();
  for (const it of sorted) {
    if (!isGrouped(it)) continue;
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

// indentTargetParent resolves the parent an item would take on a one-level
// indent move (delta 1 nests, -1 un-nests): the single statement of the rule
// behind the webapp's Tab / Shift+Tab and mobile's indent buttons. Indenting
// attaches the item to the nearest preceding active top-level item; un-indenting
// promotes it to top-level. Returns undefined when nothing can change: the item
// is completed, is already at that edge of the one-level hierarchy, has children
// (it would become a grandchild, which the server rejects), or has nothing above
// to nest under. (null is a valid answer: top-level.)
const indentTargetParent = (
  items: readonly ListItem[],
  itemId: string,
  delta: 1 | -1,
): string | null | undefined => {
  const target = items.find(it => it.id === itemId);
  if (!target || target.completed) return undefined;

  if (delta === -1) return target.parentId === null ? undefined : null;

  if (target.parentId !== null || itemHasChildren(items, itemId)) return undefined;
  let preceding: string | undefined;
  for (const it of items) {
    if (it.id === itemId) break;
    if (it.parentId === null && !it.completed) preceding = it.id;
  }
  return preceding;
};

// canChangeItemIndent reports whether changeItemIndent would move the item. It
// does the guard checks without building the re-normalized list, so a UI can
// call it on every render to enable or dim an indent control.
export const canChangeItemIndent = (items: readonly ListItem[], itemId: string, delta: 1 | -1): boolean =>
  indentTargetParent(items, itemId, delta) !== undefined;

// changeItemIndent nests (delta 1) or un-nests (delta -1) one active item by one
// level. Returns the re-normalized items, or null when canChangeItemIndent is
// false. Un-nesting a middle child re-seats its later siblings above it, since
// normalizeItemOrder keeps each group contiguous.
export const changeItemIndent = (items: readonly ListItem[], itemId: string, delta: 1 | -1): ListItem[] | null => {
  const parentId = indentTargetParent(items, itemId, delta);
  if (parentId === undefined) return null;
  return normalizeItemOrder(items.map(it => (it.id === itemId ? { ...it, parentId } : it)));
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

// completedCascadeScope is the one statement of the completed cascade, mirroring
// the server's cascadeItemCompletion: setting a top-level item's completed state
// also sets all of its children (in either direction), while unchecking a child
// also un-completes its parent — a parent can never stay "done" with an
// incomplete child. Completing every child does not auto-complete the parent;
// that still requires checking it. Returns the ids the toggle writes, whether or
// not each value actually flips; every one of them ends up at `completed`.
export const completedCascadeScope = (
  items: ReadonlyArray<Pick<ListItem, 'id' | 'parentId'>>,
  itemId: string,
  completed: boolean,
): string[] => {
  const target = items.find(item => item.id === itemId);
  if (!target) return [];
  const ids = [itemId];
  if (target.parentId === null) {
    for (const item of items) {
      if (item.parentId === itemId) ids.push(item.id);
    }
  } else if (!completed) {
    ids.push(target.parentId);
  }
  return ids;
};

// completedPriorById maps each of `ids` whose completed value would change by
// being set to `completed` to the value it has now — the "prior" a completed
// write records so a failure can revert it.
export const completedPriorById = (
  items: ReadonlyArray<Pick<ListItem, 'id' | 'completed'>>,
  ids: Iterable<string>,
  completed: boolean,
): Map<string, boolean> => {
  const targets = new Set(ids);
  const prior = new Map<string, boolean>();
  for (const item of items) {
    if (targets.has(item.id) && item.completed !== completed) prior.set(item.id, item.completed);
  }
  return prior;
};

// applyCompletedValues sets each item's completed flag from `completedById`,
// returning `items` itself when no value changes so callers can skip a commit.
export const applyCompletedValues = <T extends Pick<ListItem, 'id' | 'completed'>>(
  items: T[],
  completedById: ReadonlyMap<string, boolean>,
): T[] => {
  let changed = false;
  const next = items.map(item => {
    const value = completedById.get(item.id);
    if (value === undefined || value === item.completed) return item;
    changed = true;
    return { ...item, completed: value };
  });
  return changed ? next : items;
};

// applyCompletedCascade applies completedCascadeScope to the items.
export const applyCompletedCascade = (items: ListItem[], itemId: string, completed: boolean): ListItem[] =>
  applyCompletedValues(items, new Map(completedCascadeScope(items, itemId, completed).map(id => [id, completed])));

// moveItemIntoSlot replaces the row slotId with the item itemId, which leaves
// its own place in the list; the slot row is dropped. The moved item keeps
// everything else — completed flag, assignee, parentId — so the slot row's
// indent is ignored and normalizeItemOrder settles a child back under its
// parent. A child of the dropped slot row is promoted to top level, as the
// server's ON DELETE SET NULL does. An unknown slotId appends the item at the
// end; an unknown itemId returns the input unchanged. Used by
// reviveSuggestedItem (itemSuggestions.ts).
export const moveItemIntoSlot = (items: ListItem[], slotId: string, itemId: string): ListItem[] => {
  const moved = items.find(item => item.id === itemId);
  if (!moved) return items;
  // Replace the slot row in place rather than splicing at its old index, which
  // would land one slot late whenever the moved item sat above it.
  const next: ListItem[] = [];
  let placed = false;
  for (const item of items) {
    if (item.id === itemId) continue;
    if (item.id === slotId) {
      next.push(moved);
      placed = true;
    } else {
      next.push(item);
    }
  }
  if (!placed) next.push(moved);
  return normalizeItemOrder(next);
};

// reinsertIds re-inserts each id in `idsToRestore` back into `currentIds`,
// anchored right after its nearest still-present predecessor in
// `originalOrder` (or at the start, if none precedes it). Reverting a failed
// write this way, rather than restoring a stale full snapshot, keeps any edit
// or addition made to *other* items while the request was in flight.
export const reinsertIds = (
  currentIds: readonly string[],
  originalOrder: readonly string[],
  idsToRestore: ReadonlySet<string>,
): string[] => {
  const present = new Set(currentIds);
  const result = [...currentIds];
  for (let i = 0; i < originalOrder.length; i++) {
    const id = originalOrder[i];
    if (id === undefined || !idsToRestore.has(id)) continue;
    let anchor: string | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const candidate = originalOrder[j];
      if (candidate !== undefined && present.has(candidate)) {
        anchor = candidate;
        break;
      }
    }
    const insertAt = anchor === null ? 0 : result.indexOf(anchor) + 1;
    result.splice(insertAt, 0, id);
    present.add(id);
  }
  return result;
};

// undoMoveItemIntoSlot reverses moveItemIntoSlot after the revive it was part
// of failed: the slot row (as it was in `original`, the list before the move)
// and the moved item each go back after their nearest still-present
// predecessor in `original`. The item is taken from `items`, so edits made to
// it meanwhile survive. Returns the input unchanged when either row is missing
// or the slot row is already back.
export const undoMoveItemIntoSlot = (
  items: ListItem[],
  original: readonly ListItem[],
  slotId: string,
  itemId: string,
): ListItem[] => {
  const slotRow = original.find(item => item.id === slotId);
  const moved = items.find(item => item.id === itemId);
  if (!slotRow || !moved || items.some(item => item.id === slotId)) return items;
  const byId = new Map<string, ListItem>();
  for (const item of items) byId.set(item.id, item);
  byId.set(slotId, slotRow);
  const order = reinsertIds(
    items.filter(item => item.id !== itemId).map(item => item.id),
    original.map(item => item.id),
    new Set([slotId, itemId]),
  );
  const next: ListItem[] = [];
  for (const id of order) {
    const item = byId.get(id);
    if (item) next.push(item);
  }
  return normalizeItemOrder(next);
};
