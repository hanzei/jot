/**
 * The exponential backoff every retry uses (mobile/CLAUDE.md, Sync Loop
 * Safety): start at 1 s, double each time, cap at 60 s. A leaf module, so
 * both the drain and its scheduler can import it.
 */
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 60000;

/** Delay before the `count`-th retry (1-based). */
export function backoffDelayMs(count: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(count - 1, 0), BACKOFF_MAX_MS);
}
