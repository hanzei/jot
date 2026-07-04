// Module-level store for a pending app-icon quick action ("New note" / "New
// list" from long-pressing the launcher icon). It lives outside React for the
// same reason as the share store: a quick action can arrive before the user is
// authenticated or before the navigation tree is ready, and it must survive the
// SQLiteProvider/NavigationContainer remount that a login or server switch
// triggers. A ref inside a remounted component would be lost, so the request is
// held here and replayed once the tree is ready.

import { useSyncExternalStore } from 'react';
import type { NoteType } from '@jot/shared';

export interface PendingQuickAction {
  // The kind of note the editor should open with.
  noteType: NoteType;
}

let pendingQuickAction: PendingQuickAction | null = null;
const listeners = new Set<() => void>();

export function getPendingQuickAction(): PendingQuickAction | null {
  return pendingQuickAction;
}

export function setPendingQuickAction(next: PendingQuickAction | null): void {
  pendingQuickAction = next;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribePendingQuickAction(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePendingQuickAction(): PendingQuickAction | null {
  return useSyncExternalStore(subscribePendingQuickAction, getPendingQuickAction, getPendingQuickAction);
}
