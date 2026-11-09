import { useCallback, useSyncExternalStore } from 'react';
import { useFocusEffect } from '@react-navigation/native';

/**
 * Whether the focused note editor is showing its own "a change to this note
 * couldn't be saved" bar. The top-of-screen banners live outside the navigator,
 * so they can't see which screen is focused; this lets them hide the global
 * "N changes couldn't be saved" banner instead of stacking a second message
 * about the same failure on top of the note's.
 *
 * A count rather than a flag: two editors can be mounted at once (one stacked
 * above another), and focus moves between them in either order.
 */
let shownCount = 0;
const listeners = new Set<() => void>();

function setShownCount(next: number): void {
  shownCount = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while a focused note editor is showing its failed-change bar. */
export function useNoteFailureBarShown(): boolean {
  return useSyncExternalStore(subscribe, () => shownCount > 0);
}

/**
 * Report, from a note editor, whether it is showing its failed-change bar.
 * Counts only while the screen is focused, so a backgrounded editor below the
 * current screen does not hide the global banner.
 */
export function useReportNoteFailureBar(shown: boolean): void {
  useFocusEffect(
    useCallback(() => {
      if (!shown) return undefined;
      setShownCount(shownCount + 1);
      return () => setShownCount(shownCount - 1);
    }, [shown]),
  );
}
