import React, { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import type { LayoutRect } from '../../navigation/RootNavigator';

/**
 * Resolves the note card's current on-screen rect (window coordinates), or null
 * when it can't be measured. Registered per note id by the mounted note cards.
 */
export type CardRectMeasurer = () => Promise<LayoutRect | null>;

interface CardRectRegistry {
  /** Register a note card's measurer. Unregister the same reference on unmount. */
  register: (noteId: string, measure: CardRectMeasurer) => void;
  /** Remove a measurer. Removing one leaves any others for that id in place. */
  unregister: (noteId: string, measure: CardRectMeasurer) => void;
  /**
   * Measure the currently-mounted card(s) for a note, or null if none is
   * mounted. The *same* note can be rendered by more than one mounted list at
   * once — a checklist assigned to you shows up in both Notes and My Tasks, and
   * the drawer keeps visited screens mounted — so several cards may be
   * registered under one id. When `near` is given the rect whose centre is
   * closest to it wins; the editor passes the tap-time origin, which resolves to
   * the card the user actually opened rather than a same-note card on a hidden
   * screen.
   */
  measure: (noteId: string, near?: LayoutRect) => Promise<LayoutRect | null>;
}

const CardRectRegistryContext = createContext<CardRectRegistry | null>(null);

function centre(rect: LayoutRect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

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
  const measurers = useRef(new Map<string, Set<CardRectMeasurer>>());

  const register = useCallback((noteId: string, measure: CardRectMeasurer) => {
    const set = measurers.current.get(noteId) ?? new Set<CardRectMeasurer>();
    set.add(measure);
    measurers.current.set(noteId, set);
  }, []);

  const unregister = useCallback((noteId: string, measure: CardRectMeasurer) => {
    const set = measurers.current.get(noteId);
    if (!set) return;
    set.delete(measure);
    if (set.size === 0) measurers.current.delete(noteId);
  }, []);

  const measure = useCallback(
    async (noteId: string, near?: LayoutRect): Promise<LayoutRect | null> => {
      const set = measurers.current.get(noteId);
      if (!set || set.size === 0) return null;
      const rects = (await Promise.all([...set].map((m) => m().catch(() => null)))).filter(
        (rect): rect is LayoutRect => rect !== null,
      );
      if (rects.length === 0) return null;
      if (rects.length === 1 || !near) return rects[0]!;
      const target = centre(near);
      let best = rects[0]!;
      let bestDistance = Infinity;
      for (const rect of rects) {
        const c = centre(rect);
        const distance = (c.x - target.x) ** 2 + (c.y - target.y) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = rect;
        }
      }
      return best;
    },
    [],
  );

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
