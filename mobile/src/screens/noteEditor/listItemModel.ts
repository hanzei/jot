import {
  VALIDATION,
  applyCompletedCascade,
  dropTargetParentId,
  itemHasChildren,
  normalizeItemOrder,
  type ListItem,
  type NoteItem,
  type NoteType,
} from '@jot/shared';

// Captured as a module-level number so the worklet form of indentLevelFromDrag
// can reference it on the UI thread without a property access on an import.
const INDENT_PX = VALIDATION.INDENT_PX_PER_LEVEL;

// Editor-local representation of a list item — an alias for @jot/shared's
// `ListItem`, kept under this name because it is how NoteEditorScreen and its
// row components already refer to it. The ordering/cascade/drop-target rules
// that operate on it live in `@jot/shared` (`listItems.ts`), shared with the
// webapp editor; this file re-exports them alongside the mobile-specific
// helpers (server-shape conversion, drag-distance-to-indent-level mapping)
// that have no webapp equivalent.
export type LocalItem = ListItem;

export { applyCompletedCascade, dropTargetParentId, itemHasChildren, normalizeItemOrder };

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

// isBlankDraft reports whether a not-yet-created note has nothing worth saving:
// flushSave declines to create it, and the toolbar disables Archive on it.
// Colour and pin alone do not count; they ride along once content triggers the
// create.
export function isBlankDraft(noteType: NoteType, title: string, content: string, items: readonly LocalItem[]): boolean {
  return noteType === 'list' ? !title && items.length === 0 : !content;
}

// The per-item save baseline lives in @jot/shared (`itemDiff.ts`) with the rest
// of the diff engine; re-exported so the editor's hooks keep one import site.
export { itemSnapshot, type ItemSnapshot } from '@jot/shared';

// indentTargetParent resolves the parent an item would take on a one-level
// indent move (delta 1 nests, -1 un-nests), mirroring the webapp's Tab /
// Shift+Tab. Indenting attaches the item to the nearest preceding active
// top-level item; un-indenting promotes it to top-level. Returns undefined when
// nothing can change: the item is completed, is already at that edge of the
// one-level hierarchy, has children (it would become a grandchild), or has
// nothing above to nest under. (null is a valid answer: top-level.)
function indentTargetParent(items: readonly LocalItem[], itemId: string, delta: 1 | -1): string | null | undefined {
  const target = items.find((item) => item.id === itemId);
  if (!target || target.completed) return undefined;

  if (delta === -1) return target.parentId === null ? undefined : null;

  if (target.parentId !== null || itemHasChildren(items, itemId)) return undefined;
  let preceding: string | undefined;
  for (const item of items) {
    if (item.id === itemId) break;
    if (item.parentId === null && !item.completed) preceding = item.id;
  }
  return preceding;
}

// canChangeItemIndent reports whether changeItemIndent would move the item. The
// formatting bar calls it on every render to dim its buttons, so it does the
// guard checks without building the re-normalized list.
export function canChangeItemIndent(items: readonly LocalItem[], itemId: string, delta: 1 | -1): boolean {
  return indentTargetParent(items, itemId, delta) !== undefined;
}

// changeItemIndent nests (delta 1) or un-nests (delta -1) one active item by one
// level for the formatting bar's indent buttons. Returns the re-normalized
// items, or null when canChangeItemIndent is false.
export function changeItemIndent(items: readonly LocalItem[], itemId: string, delta: 1 | -1): LocalItem[] | null {
  const parentId = indentTargetParent(items, itemId, delta);
  if (parentId === undefined) return null;
  return normalizeItemOrder(items.map((item) => (item.id === itemId ? { ...item, parentId } : item)));
}

// indentLevelFromDrag maps a horizontal drag distance to a target indent level
// (0 = top-level, 1 = nested) for the one-level hierarchy, snapping every
// INDENT_PX of travel to one level and clamping to what the dragged item is
// allowed to do. It is a worklet so the active row's animated style can call it
// on the UI thread for live visual feedback; it is also called from JS on drop
// to commit the change, so both paths stay in agreement.
//   - baseLevel: the item's level when the drag began.
//   - canIndent: false when the item already has children (a parent can't nest)
//     or there is no row above it to nest under.
//   - canOutdent: false when the item is already top-level.
export function indentLevelFromDrag(
  translationX: number,
  baseLevel: number,
  canIndent: boolean,
  canOutdent: boolean,
): number {
  'worklet';
  const steps = Math.round(translationX / INDENT_PX);
  let level = baseLevel + steps;
  if (level < 0) level = 0;
  if (level > 1) level = 1;
  if (level > baseLevel && !canIndent) level = baseLevel;
  if (level < baseLevel && !canOutdent) level = baseLevel;
  return level;
}
