// The completed-item autocomplete both note editors offer while a list row is
// being typed in: which completed items are suggested, on which rows, and
// which item accepting a suggestion revives. The editors keep only the UI
// state (whether the row started empty, the dropdown/chips) and the accept
// handler itself, which moves the item with moveItemIntoSlot and unchecks it
// through their checkbox toggle path.

import type { ListItem } from './listItems';

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
export const findSuggestedItem = <T extends ListItem>(items: readonly T[], suggestion: string): T | undefined => {
  const key = suggestion.trim().toLowerCase();
  return items.find(item => item.completed && item.text.trim().toLowerCase() === key);
};
