// The completed-item autocomplete both note editors offer while a list row is
// being typed in: which completed items are suggested, on which rows, and what
// accepting one does. The editors keep only the UI state (whether the row
// started empty, the dropdown/chips) and the wiring to their own item state.

import { moveItemIntoSlot, undoMoveItemIntoSlot, type ListItem } from './listItems';

/** The most suggestions a row shows at once. */
export const MAX_ITEM_SUGGESTIONS = 5;

/**
 * Where a row stands for suggestions. Accepting a suggestion consumes the row
 * being typed in, so suggestions are offered only where nothing is lost by
 * that:
 *
 * - `startedEmpty`: the row was empty when the caret entered it — a new row,
 *   never an existing item being edited, whose id, assignee and history the
 *   swap would discard. Editors capture it at focus rather than reading the
 *   saved baseline, which autosave advances while a new row is still being
 *   typed into.
 * - `hasChildren`: other items are nested under the row; consuming it would
 *   orphan them.
 */
export interface SuggestionRow {
  startedEmpty: boolean;
  hasChildren: boolean;
}

/**
 * The distinct, trimmed texts of the completed items in `items`, in list
 * order. Case-insensitive duplicates keep the first spelling; blank texts are
 * skipped. Callers pass the items they want to suggest from (the webapp leaves
 * out ones in the delete-undo window).
 */
export const distinctCompletedTexts = (items: readonly ListItem[]): string[] => {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const item of items) {
    if (!item.completed) continue;
    const trimmed = item.text.trim();
    const key = trimmed.toLowerCase();
    if (trimmed && !seen.has(key)) {
      seen.add(key);
      texts.push(trimmed);
    }
  }
  return texts;
};

/**
 * The suggestions to show while `text` is typed into `row`: completed texts
 * containing it, ignoring case, other than an exact match, at most
 * {@link MAX_ITEM_SUGGESTIONS}. None for an ineligible row or blank text.
 */
export const itemSuggestions = (
  text: string,
  completedTexts: readonly string[],
  row: SuggestionRow,
): string[] => {
  if (!row.startedEmpty || row.hasChildren) return [];
  const query = text.trim().toLowerCase();
  if (!query) return [];
  const results: string[] = [];
  for (const candidate of completedTexts) {
    const lower = candidate.toLowerCase();
    if (lower.includes(query) && lower !== query) {
      results.push(candidate);
      if (results.length === MAX_ITEM_SUGGESTIONS) break;
    }
  }
  return results;
};

/**
 * The completed item an accepted suggestion revives: the first, in list order,
 * whose trimmed text matches it ignoring case — the same item
 * {@link distinctCompletedTexts} took the spelling from.
 */
export const findSuggestedItem = (items: readonly ListItem[], suggestion: string): ListItem | undefined => {
  const key = suggestion.trim().toLowerCase();
  return items.find(item => item.completed && item.text.trim().toLowerCase() === key);
};

/** How {@link reviveSuggestedItem} reaches an editor's item state. */
export interface ReviveSuggestionHooks {
  /** The editor's latest items (its live ref, not a render snapshot). */
  read: () => ListItem[];
  commit: (items: ListItem[]) => void;
  /**
   * Unchecks an item through the editor's checkbox toggle path, resolving
   * false only when the request failed and its flags were reverted.
   */
  uncheck: (itemId: string) => Promise<boolean>;
  /** Persists the remaining changes (the slot row's removal, the new order). */
  save: () => void;
}

/**
 * Accepting a suggestion: the row being typed in (`slotId`) is consumed and
 * the completed item it matched (`itemId`) takes its place, then is unchecked
 * exactly as its checkbox would — the toggle endpoint applies the parent/child
 * cascade atomically, and the editor's save diff leaves the flags that write
 * claims alone until it settles. The save runs only once the toggle has
 * settled, so the typed row's removal is normally sent only for a revive that
 * happened; when the toggle fails, the typed row and the item go back where
 * they were and the save has nothing of the attempt left to send. (A save pass
 * already running can still send the removal earlier; the undo then re-creates
 * the row under its own id.)
 */
// Written with .then rather than async/await: mobile's Babel compiles shared/
// and can lower an async function to a @babel/runtime helper, which shared/
// cannot resolve — the same trap as array destructuring. No shared code uses
// async yet; keep it that way unless the mobile suite proves it safe.
export const reviveSuggestedItem = (slotId: string, itemId: string, hooks: ReviveSuggestionHooks): Promise<void> => {
  const original = hooks.read();
  hooks.commit(moveItemIntoSlot(original, slotId, itemId));
  return hooks.uncheck(itemId).then(revived => {
    if (!revived) hooks.commit(undoMoveItemIntoSlot(hooks.read(), original, slotId, itemId));
    hooks.save();
  });
};
