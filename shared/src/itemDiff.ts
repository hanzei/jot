// The diff half of both note editors' autosave engines. Each editor keeps a
// baseline of the last-known server state and, on save, turns the difference
// between that baseline and its current state into the smallest set of
// requests: a scalar PATCH carrying only the fields that moved, and granular
// create/patch/delete/reorder operations for list items. Never re-sending the
// whole note is what stops a save on one device from clobbering a concurrent
// edit to an untouched field or item on another.
//
// Everything here is pure. The clients keep the transport and the loop that
// sends these operations in order and advances the baseline after each one
// succeeds, so a failure part-way through never re-sends an operation that
// already landed.

import type { ListItem } from './listItems';
import type {
  CreateNoteItemRequest,
  NoteType,
  PatchNoteItemRequest,
  UpdateListNoteRequest,
  UpdateNoteRequest,
  UpdateTextNoteRequest,
} from './types';

/**
 * The mergeable fields of a list item, stored per item as the diff baseline.
 * Position is deliberately absent: order is tracked separately, as a list of
 * ids, and persisted with a single reorder.
 */
export type ItemSnapshot = Pick<ListItem, 'text' | 'completed' | 'parentId' | 'assigned_to'>;

export const itemSnapshot = (item: ListItem): ItemSnapshot => ({
  text: item.text,
  completed: item.completed,
  parentId: item.parentId,
  assigned_to: item.assigned_to,
});

/** One granular item request, in the order {@link diffItems} emits them. */
export type ItemDiffOp =
  | { kind: 'create'; itemId: string; request: CreateNoteItemRequest; snapshot: ItemSnapshot }
  | { kind: 'patch'; itemId: string; patch: PatchNoteItemRequest; snapshot: ItemSnapshot }
  | { kind: 'delete'; itemId: string }
  | { kind: 'reorder'; itemIds: string[] };

/**
 * Builds the body for `POST /notes/{id}/items`. The server's `parent_id` is a
 * plain string where empty means top-level (null decodes to the same thing, but
 * only by accident of Go's JSON decoder), so a top-level item sends `''`.
 */
export const createItemRequest = (item: ListItem): CreateNoteItemRequest => ({
  id: item.id,
  text: item.text,
  position: item.position,
  completed: item.completed,
  parent_id: item.parentId ?? '',
  ...(item.assigned_to ? { assigned_to: item.assigned_to } : {}),
});

/** The fields of `item` that differ from `snap`, as a partial item PATCH. */
export const itemPatch = (snap: ItemSnapshot, item: ListItem): PatchNoteItemRequest => {
  const patch: PatchNoteItemRequest = {};
  if (item.text !== snap.text) patch.text = item.text;
  if (item.completed !== snap.completed) patch.completed = item.completed;
  // '' re-parents to top-level; null would mean "leave unchanged".
  if (item.parentId !== snap.parentId) patch.parent_id = item.parentId ?? '';
  if (item.assigned_to !== snap.assigned_to) patch.assigned_to = item.assigned_to;
  return patch;
};

const orderChanged = (savedOrder: readonly string[], curOrder: readonly string[]): boolean =>
  curOrder.length !== savedOrder.length || curOrder.some((id, i) => savedOrder[i] !== id);

/**
 * Compares the current items against the saved baseline and returns the
 * operations that bring the server in line: creates and patches in list order
 * (so a parent is created before its children), then deletes, then one
 * reorder if the id order moved. Patches carry only the changed fields.
 *
 * An empty list emits no reorder (the server rejects an empty one); its deletes
 * already say everything. Callers still set their saved order to the current
 * order once every operation has succeeded.
 */
export function diffItems(
  savedItems: ReadonlyMap<string, ItemSnapshot>,
  savedOrder: readonly string[],
  items: readonly ListItem[],
): ItemDiffOp[] {
  const ops: ItemDiffOp[] = [];
  const curIds = new Set<string>();

  for (const it of items) {
    curIds.add(it.id);
    const snap = savedItems.get(it.id);
    if (!snap) {
      ops.push({ kind: 'create', itemId: it.id, request: createItemRequest(it), snapshot: itemSnapshot(it) });
      continue;
    }
    const patch = itemPatch(snap, it);
    if (Object.keys(patch).length > 0) {
      ops.push({ kind: 'patch', itemId: it.id, patch, snapshot: itemSnapshot(it) });
    }
  }

  for (const id of savedItems.keys()) {
    if (!curIds.has(id)) ops.push({ kind: 'delete', itemId: id });
  }

  const curOrder = items.map(it => it.id);
  if (curOrder.length > 0 && orderChanged(savedOrder, curOrder)) {
    ops.push({ kind: 'reorder', itemIds: curOrder });
  }
  return ops;
}

/**
 * True when the items differ from the baseline in any way a save would send —
 * or in order alone, which also covers an emptied list whose deletes the
 * baseline has already absorbed.
 */
export const itemsDiffer = (
  savedItems: ReadonlyMap<string, ItemSnapshot>,
  savedOrder: readonly string[],
  items: readonly ListItem[],
): boolean =>
  orderChanged(savedOrder, items.map(it => it.id)) || diffItems(savedItems, savedOrder, items).length > 0;

/**
 * The scalar (non-item) fields of a note as an editor holds them. A text note
 * has no title or collapse state and a list note no content (editors hold
 * `''`/`false` there), so {@link buildScalarPatch} reads only the half that
 * applies to the note type.
 */
export interface NoteScalars {
  title: string;
  content: string;
  pinned: boolean;
  archived: boolean;
  color: string;
  checked_items_collapsed: boolean;
}

/**
 * A note PATCH containing only the scalar fields that differ from the saved
 * baseline, or null when nothing moved. It never carries `base_version`; a
 * caller that version-guards content edits adds it (see
 * {@link patchTouchesSharedContent}).
 */
export function buildScalarPatch(
  noteType: NoteType,
  current: NoteScalars,
  saved: NoteScalars,
): UpdateNoteRequest | null {
  const patch: UpdateTextNoteRequest & UpdateListNoteRequest = {};
  if (current.pinned !== saved.pinned) patch.pinned = current.pinned;
  if (current.archived !== saved.archived) patch.archived = current.archived;
  if (current.color !== saved.color) patch.color = current.color;
  if (noteType === 'list') {
    if (current.title !== saved.title) patch.title = current.title;
    if (current.checked_items_collapsed !== saved.checked_items_collapsed) {
      patch.checked_items_collapsed = current.checked_items_collapsed;
    }
  } else if (current.content !== saved.content) {
    patch.content = current.content;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Whether a note PATCH changes the shared, version-guarded content (title or
 * content). Only those writes take a `base_version`; per-user fields (pin,
 * archive, color, collapse) are never version-checked by the server.
 */
export const patchTouchesSharedContent = (patch: UpdateNoteRequest): boolean => {
  const fields = patch as { title?: string; content?: string };
  return fields.title !== undefined || fields.content !== undefined;
};
