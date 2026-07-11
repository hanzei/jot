import type { User } from '@jot/shared';

// A module-level pub/sub bridging the SSE stream to UsersContext. UsersProvider
// sits *above* SSEProvider in the tree (App.tsx), so UsersContext can't consume
// SSEContext directly. This decouples them the same way sseState and
// serverSwitchLifecycle decouple the SSE layer from their consumers.
type ProfileIconUpdateListener = (user: User) => void;

const listeners = new Set<ProfileIconUpdateListener>();

export function publishProfileIconUpdate(user: User): void {
  for (const listener of listeners) {
    listener(user);
  }
}

export function subscribeToProfileIconUpdates(listener: ProfileIconUpdateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
