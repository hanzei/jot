// Tracks which in-flight completed-toggle last wrote each list item, so a
// toggle's response reconciles only the items it still owns.
//
// The toggle endpoint returns the note's *full* item list as the server saw it
// right after that one write. When rows are checked off faster than requests
// come back, the response to an earlier tap still reports every later-tapped
// item unchecked (and responses can land out of order). Applying the whole list
// puts those rows back in the active list until their own responses land —
// or, if the stale response lands last, leaves them unchecked locally while the
// server has them checked. Restricting each response to the items its toggle
// wrote, minus any a later toggle has since claimed, makes the most recent tap
// on an item the one whose response decides it. Items outside that set are
// left alone; the note re-read that follows every write reconciles them.

import type { ListItem } from './listItems';

type CascadeItem = Pick<ListItem, 'id' | 'parentId'>;

/**
 * The ids a toggle of `itemId` to `completed` writes, mirroring
 * applyCompletedCascade (and the server's cascadeItemCompletion): the item, its
 * children when it is top-level, and its parent when a child is unchecked —
 * whether or not each value actually flips.
 */
export const completedCascadeScope = (items: CascadeItem[], itemId: string, completed: boolean): string[] => {
  const target = items.find(item => item.id === itemId);
  if (!target) return [];
  const ids = [itemId];
  if (target.parentId === null) {
    for (const item of items) {
      if (item.parentId === itemId) ids.push(item.id);
    }
  } else if (!completed) {
    ids.push(target.parentId);
  }
  return ids;
};

export interface CompletedWriteTracker {
  /** Records a write to `ids` and returns its token. A later write to an id takes it over. */
  begin(ids: Iterable<string>): number;
  /** Whether `id`'s most recent write is still the one identified by `token`. */
  owns(token: number, id: string): boolean;
  /** Releases the ids the write still owns. Call once the write has settled. */
  end(token: number): void;
}

export const createCompletedWriteTracker = (): CompletedWriteTracker => {
  const latestWriteById = new Map<string, number>();
  let nextToken = 0;
  return {
    begin(ids) {
      nextToken += 1;
      for (const id of ids) latestWriteById.set(id, nextToken);
      return nextToken;
    },
    owns(token, id) {
      return latestWriteById.get(id) === token;
    },
    end(token) {
      for (const entry of latestWriteById) {
        if (entry[1] === token) latestWriteById.delete(entry[0]);
      }
    },
  };
};
