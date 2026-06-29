/**
 * Pure helpers for the two-column staggered (masonry) dashboard layout.
 *
 * These contain all of the layout/reorder math used by the draggable masonry so
 * the gesture component stays thin and this logic can be unit-tested without a
 * device. Coordinates are in content space (origin at the top-left of the
 * masonry content area).
 */

export interface PlacedItem {
  id: string;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PackOptions {
  columnWidth: number;
  columnGap: number;
  rowGap: number;
  /** Number of columns. Defaults to 2. */
  columns?: number;
  /** Height used for cards that have not been measured yet. */
  estimatedHeight?: number;
}

const DEFAULT_COLUMNS = 2;
const DEFAULT_ESTIMATED_HEIGHT = 120;

/**
 * Packs an ordered list of ids into the shortest-column-first masonry layout
 * and returns each card's absolute position plus the overall content height.
 */
export function packColumns(
  order: string[],
  heights: Record<string, number>,
  options: PackOptions,
): { placed: PlacedItem[]; containerHeight: number } {
  const columns = Math.max(1, options.columns ?? DEFAULT_COLUMNS);
  const estimated = options.estimatedHeight ?? DEFAULT_ESTIMATED_HEIGHT;
  const colHeights = new Array<number>(columns).fill(0);
  const placed: PlacedItem[] = [];

  for (const id of order) {
    const height = heights[id] ?? estimated;
    // Place into the currently-shortest column (ties go to the leftmost).
    let col = 0;
    for (let c = 1; c < columns; c++) {
      if (colHeights[c] < colHeights[col]) col = c;
    }
    const x = col * (options.columnWidth + options.columnGap);
    const y = colHeights[col];
    placed.push({ id, column: col, x, y, width: options.columnWidth, height });
    colHeights[col] = y + height + options.rowGap;
  }

  const tallest = colHeights.reduce((max, h) => (h > max ? h : max), 0);
  // Strip the trailing rowGap so the container hugs the last card.
  const containerHeight = tallest > 0 ? Math.max(0, tallest - options.rowGap) : 0;
  return { placed, containerHeight };
}

/**
 * Given the placed cards (excluding the one being dragged, in flat order) and a
 * pointer position in content space, returns the index at which the dragged
 * card should be inserted into that "without active" ordering.
 *
 * Preference is given to the column the pointer is over so dragging within a
 * column feels stable; if the pointer's column has no cards, the nearest card
 * overall is used.
 */
export function computeInsertionIndex(
  placedExclActive: PlacedItem[],
  pointerX: number,
  pointerY: number,
  options: Pick<PackOptions, 'columnWidth' | 'columnGap' | 'columns'>,
): number {
  if (placedExclActive.length === 0) return 0;

  const columns = Math.max(1, options.columns ?? DEFAULT_COLUMNS);
  const colSpan = options.columnWidth + options.columnGap;
  let pointerCol = colSpan > 0 ? Math.floor(pointerX / colSpan) : 0;
  if (pointerCol < 0) pointerCol = 0;
  if (pointerCol > columns - 1) pointerCol = columns - 1;

  let bestIdx = -1;
  let bestDist = Infinity;
  let restrictedToColumn = false;

  for (let i = 0; i < placedExclActive.length; i++) {
    const card = placedExclActive[i];
    const sameColumn = card.column === pointerCol;

    if (restrictedToColumn && !sameColumn) continue;
    if (sameColumn && !restrictedToColumn) {
      // First same-column card: discard cross-column candidates and only
      // compare against this column from here on.
      restrictedToColumn = true;
      bestIdx = -1;
      bestDist = Infinity;
    }

    const centerY = card.y + card.height / 2;
    const dist = Math.abs(pointerY - centerY);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  if (bestIdx === -1) return placedExclActive.length;
  const nearest = placedExclActive[bestIdx];
  const nearestCenterY = nearest.y + nearest.height / 2;
  return pointerY < nearestCenterY ? bestIdx : bestIdx + 1;
}

/**
 * Returns a new ordering with `id` moved to `targetIndex`, where `targetIndex`
 * is expressed in the ordering that excludes `id` (i.e. the value returned by
 * {@link computeInsertionIndex}).
 */
export function moveToIndex(order: string[], id: string, targetIndex: number): string[] {
  const without = order.filter((x) => x !== id);
  const clamped = Math.max(0, Math.min(targetIndex, without.length));
  without.splice(clamped, 0, id);
  return without;
}
