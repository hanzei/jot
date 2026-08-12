import { VALIDATION, type ListItem, type NoteItem } from '@jot/shared';

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

export {
  applyCompletedCascade,
  dropTargetParentId,
  itemHasChildren,
  normalizeItemOrder,
} from '@jot/shared';

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
