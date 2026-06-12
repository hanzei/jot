// Module-level store for a pending Android share ("create note from shared
// text"). It deliberately lives outside React because handling a share can
// trigger a server switch, which remounts the entire navigation tree (the
// SQLiteProvider key changes). A ref inside a remounted component would be
// lost, so the pending share is held here and replayed once the new tree is
// ready.

import { useSyncExternalStore } from 'react';

export interface PendingShare {
  // The text to pre-fill the new note with.
  text: string;
  // When set, the share should be created on this server. If it is not the
  // active server, the handler switches to it (remount + replay) before opening
  // the editor. Used when the user redirects a share to another server.
  targetServerId?: string;
}

let pendingShare: PendingShare | null = null;
const listeners = new Set<() => void>();

export function getPendingShare(): PendingShare | null {
  return pendingShare;
}

export function setPendingShare(next: PendingShare | null): void {
  pendingShare = next;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribePendingShare(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePendingShare(): PendingShare | null {
  return useSyncExternalStore(subscribePendingShare, getPendingShare, getPendingShare);
}
