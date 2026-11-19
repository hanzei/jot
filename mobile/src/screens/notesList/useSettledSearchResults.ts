import { useState } from 'react';
import type { Note } from '@jot/shared';

/** One search's results, as the notes list reads them from its two queries. */
export interface SearchResults {
  search: string;
  /** Undefined while its read is pending. */
  notes: Note[] | undefined;
  /** The separate archived-matches read; undefined while pending or unused. */
  archived: Note[] | undefined;
}

interface Settled {
  view: string;
  results: SearchResults;
}

/**
 * The results the notes list should render while its search changes.
 *
 * Each search term is its own query key, so a new term starts with no data and
 * its two reads (active notes, and archived matches when the split is on) land
 * separately. Rendering them as they arrive would flash a spinner, then mix
 * one term's active notes with another's archived matches. Instead this keeps
 * the last *settled* results — every read it needs has data — on screen until
 * the new term's reads have all landed, then swaps once.
 *
 * Query data always belongs to its current key, so `search` in the returned
 * results is the term they really match. Read the shown term from here, not
 * from the input.
 *
 * Only results for the same `view` are held: a different label, archive or
 * trash scope, or server, selects other notes, and showing the old ones there
 * would be wrong. Those changes, and the first load, return `current` as is.
 */
export function useSettledSearchResults(
  view: string,
  current: SearchResults,
  needsArchived: boolean,
): SearchResults {
  const [settled, setSettled] = useState<Settled | null>(null);
  const isSettled = current.notes !== undefined && (!needsArchived || current.archived !== undefined);

  if (!isSettled) {
    return settled !== null && settled.view === view ? settled.results : current;
  }
  if (
    settled === null ||
    settled.view !== view ||
    settled.results.search !== current.search ||
    settled.results.notes !== current.notes ||
    settled.results.archived !== current.archived
  ) {
    setSettled({ view, results: current });
  }
  return current;
}
