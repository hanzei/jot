import type { NoteItem } from '@jot/shared';

/**
 * Editor-local representation of a list item. Mirrors the server's {@link NoteItem}
 * but uses camelCase `parentId` and is the shape NoteEditorScreen edits in state
 * before diffing changes into granular per-item operations.
 */
export interface LocalItem {
  id: string;
  text: string;
  completed: boolean;
  position: number;
  parentId: string | null;
  assigned_to: string;
}

export function toLocalItems(serverItems: NoteItem[]): LocalItem[] {
  return [...serverItems]
    .sort((a, b) => a.position - b.position)
    .map((item) => ({
      id: item.id,
      text: item.text,
      completed: item.completed,
      position: item.position,
      parentId: item.parent_id ?? null,
      assigned_to: item.assigned_to ?? '',
    }));
}

export function serializeItems(items: LocalItem[]) {
  return items.map((item, i) => ({
    id: item.id,
    text: item.text,
    position: i,
    completed: item.completed,
    indent_level: item.parentId ? 1 : 0,
    assigned_to: item.assigned_to,
  }));
}

// Mergeable fields of a list item, used as the per-item baseline for diffing
// local edits against the last-saved state.
export type ItemSnapshot = Pick<LocalItem, 'text' | 'completed' | 'parentId' | 'assigned_to'>;

export const itemSnapshot = (item: LocalItem): ItemSnapshot => ({
  text: item.text,
  completed: item.completed,
  parentId: item.parentId,
  assigned_to: item.assigned_to,
});

// normalizeItemOrder walks top-level items in order and emits each one followed
// by its children (keeping a group contiguous). Orphaned children (parent gone)
// are promoted to top-level. Renumbers position = 0..N across the whole set.
export function normalizeItemOrder(items: LocalItem[]): LocalItem[] {
  const childrenByParent = new Map<string, LocalItem[]>();
  for (const it of items) {
    if (it.parentId !== null) {
      const siblings = childrenByParent.get(it.parentId) ?? [];
      siblings.push(it);
      childrenByParent.set(it.parentId, siblings);
    }
  }
  const ordered: LocalItem[] = [];
  const placed = new Set<string>();
  for (const it of items) {
    if (it.parentId !== null) continue;
    ordered.push(it);
    placed.add(it.id);
    for (const child of childrenByParent.get(it.id) ?? []) {
      ordered.push(child);
      placed.add(child.id);
    }
  }
  for (const it of items) {
    if (!placed.has(it.id)) ordered.push({ ...it, parentId: null });
  }
  return ordered.map((it, index) => ({ ...it, position: index }));
}

export function itemHasChildren(items: LocalItem[], itemId: string): boolean {
  return items.some((it) => it.parentId === itemId);
}

// droppedParentId decides which group a just-dragged item should belong to,
// based on the row it landed directly below (`above`). Supports moving items
// between groups by dragging. Rules for the 1-level hierarchy:
//   - an item that has children always stays top-level (can't nest a parent);
//   - a leaf joins the same parent as the row above it if that row is a child;
//   - a leaf dropped right under a top-level group head becomes its child;
//   - otherwise (top-level row above, or dropped at the very top) it is top-level.
export function droppedParentId(
  allItems: LocalItem[],
  moved: LocalItem,
  above: LocalItem | null,
): string | null {
  if (itemHasChildren(allItems, moved.id)) return null;
  if (!above) return null;
  if (above.parentId !== null) return above.parentId;
  if (itemHasChildren(allItems, above.id)) return above.id;
  return null;
}

export function precedingTopLevelId(items: LocalItem[], itemId: string): string | null {
  let last: string | null = null;
  for (const it of items) {
    if (it.id === itemId) return last;
    if (it.parentId === null) last = it.id;
  }
  return null;
}

// applyCompletedCascade mirrors the server: toggling a top-level item also
// toggles all its children; toggling a child touches only that item.
//
// NOTE: this rule must stay in agreement with `collectToggleCascade` in
// hooks/useNotes.ts (which performs the same cascade over the server-shaped
// NoteItem[] for the optimistic cache + offline DB write). The two operate on
// different item shapes (LocalItem.parentId vs NoteItem.parent_id) but must
// produce the same set of toggled ids.
export function applyCompletedCascade(items: LocalItem[], itemId: string, completed: boolean): LocalItem[] {
  const target = items.find((item) => item.id === itemId);
  if (!target) return items;
  const cascadeToChildren = target.parentId === null;
  return items.map((item) => {
    if (item.id === itemId) return { ...item, completed };
    if (cascadeToChildren && item.parentId === itemId) return { ...item, completed };
    return item;
  });
}
