/**
 * Multi-select on the note grid (#1255) applies an action by sending one
 * request per note. The cap keeps a batch — and its undo — well under the
 * server's general per-user rate limit (300 requests a minute), so a large
 * selection is refused up front instead of failing halfway through.
 */
export const MAX_BATCH_NOTES = 100;

export interface BatchResult<T> {
  succeeded: T[];
  failed: T[];
  /** The first failure's error, for the error toast's request reference. */
  firstError: unknown;
}

/**
 * Runs `apply` on each item, one after another. Sequential on purpose: each
 * pin moves the note to the end of the pinned list, so parallel requests would
 * leave the pinned order to whichever landed first, and it keeps a batch from
 * bursting a hundred requests at the server at once. A failure is recorded
 * and the rest still run.
 */
export async function runSequentially<T>(items: readonly T[], apply: (item: T) => Promise<unknown>): Promise<BatchResult<T>> {
  const result: BatchResult<T> = { succeeded: [], failed: [], firstError: undefined };
  for (const item of items) {
    try {
      await apply(item);
      result.succeeded.push(item);
    } catch (error) {
      if (result.failed.length === 0) result.firstError = error;
      result.failed.push(item);
    }
  }
  return result;
}

/**
 * The ids from `orderedIds` between `anchorId` and `targetId`, both included,
 * for a shift-click range. Null when either is not in the list.
 */
export function idRange(orderedIds: readonly string[], anchorId: string, targetId: string): string[] | null {
  const anchorIndex = orderedIds.indexOf(anchorId);
  const targetIndex = orderedIds.indexOf(targetId);
  if (anchorIndex < 0 || targetIndex < 0) return null;
  return orderedIds.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1);
}
