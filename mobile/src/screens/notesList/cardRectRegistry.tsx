import React, { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import type { LayoutRect } from '../../navigation/RootNavigator';

/**
 * Resolves the note card's current on-screen rect (window coordinates), or null
 * when it can't be measured. Registered per note id by the mounted note cards.
 */
export type CardRectMeasurer = () => Promise<LayoutRect | null>;

interface CardRectRegistry {
  /** Register a note card's measurer. Call again to replace; unregister on unmount. */
  register: (noteId: string, measure: CardRectMeasurer) => void;
  /** Remove a measurer. The `measure` reference guards against clobbering a
   *  remount that already registered a newer one. */
  unregister: (noteId: string, measure: CardRectMeasurer) => void;
  /** Measure the currently-mounted card for a note, or null if none is mounted. */
  measure: (noteId: string) => Promise<LayoutRect | null>;
}

const CardRectRegistryContext = createContext<CardRectRegistry | null>(null);

/**
 * Shares live note-card positions from the notes list to the note editor.
 *
 * The two are sibling screens in the stack, and the editor's zoom-close needs
 * the card's *current* rect — not the frozen tap-time `originRect`, which goes
 * stale the moment the list reflows underneath the open editor (a longer note,
 * a pin, a reorder, a sort change). Cards register a measurer keyed by note id;
 * the editor measures the live card at close time and falls back to the frozen
 * rect when the card is gone (archived/trashed/deleted, or not mounted).
 */
export function CardRectRegistryProvider({ children }: { children: React.ReactNode }) {
  const measurers = useRef(new Map<string, CardRectMeasurer>());

  const register = useCallback((noteId: string, measure: CardRectMeasurer) => {
    measurers.current.set(noteId, measure);
  }, []);

  const unregister = useCallback((noteId: string, measure: CardRectMeasurer) => {
    if (measurers.current.get(noteId) === measure) {
      measurers.current.delete(noteId);
    }
  }, []);

  const measure = useCallback(async (noteId: string): Promise<LayoutRect | null> => {
    const measurer = measurers.current.get(noteId);
    return measurer ? measurer() : null;
  }, []);

  const value = useMemo<CardRectRegistry>(
    () => ({ register, unregister, measure }),
    [register, unregister, measure],
  );

  return <CardRectRegistryContext.Provider value={value}>{children}</CardRectRegistryContext.Provider>;
}

/**
 * Access the card-rect registry. Returns null when rendered outside a provider
 * (e.g. unit tests) so callers degrade to the frozen `originRect`.
 */
export function useCardRectRegistry(): CardRectRegistry | null {
  return useContext(CardRectRegistryContext);
}
