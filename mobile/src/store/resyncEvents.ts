// A module-level pub/sub that signals a one-shot "catch-up" resync of the major
// read caches (notes, labels, users) after the SSE live stream re-establishes.
//
// SSE is a live push stream with no backfill: any note_*/labels_changed/
// profile_icon_updated event emitted while the stream is down (e.g. the app was
// backgrounded, which tears the stream down in useSSE) is lost. The read-side
// background syncs otherwise only re-run on an isConnected flip, which does not
// happen when the app is merely foregrounded on a stable network. Firing this
// signal on SSE reconnect closes that gap.
//
// It's a module bus (like profileIconEvents) because subscribers span providers
// both above (UsersProvider) and below (the note/label hooks) SSEProvider in the
// tree, so they can't share a React context with the SSE layer.
type ReconnectResyncListener = () => void;

const listeners = new Set<ReconnectResyncListener>();

export function publishReconnectResync(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeToReconnectResync(listener: ReconnectResyncListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
