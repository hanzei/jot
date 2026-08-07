// Persisted store for a deep link tapped while signed out. The link is stashed
// here and replayed by useDeepLinkRouting once the user is authenticated and
// the navigation tree is ready.
//
// It is persisted rather than held in a React ref because the sign-in that has
// to happen first is exactly when the JS context is most likely to go away: the
// user leaves for a password manager and the OS reclaims the app, they
// background it mid-login, or it crashes. The webapp survives the equivalent
// reload because the target lives in the URL (`?continue=`); mobile has no such
// carrier, so it needs storage.
//
// The value is short-lived on purpose. It is dropped on replay, on the
// authenticated -> unauthenticated transition (so a logout never replays the
// previous session's link), and on expiry.

import * as SecureStore from 'expo-secure-store';
import { isJotSchemeUrl, isProtectedDeepLinkPath, getDeepLinkPath } from '../utils/deepLink';

const PENDING_DEEP_LINK_KEY = 'jot_pending_deep_link';

// How long a stashed link stays replayable. Long enough to cover a trip to a
// password manager and an app relaunch, short enough that a link the user has
// forgotten about never yanks them out of the dashboard on some later sign-in.
export const PENDING_DEEP_LINK_TTL_MS = 10 * 60 * 1000;

interface StoredPendingDeepLink {
  url: string;
  // Epoch milliseconds, for the TTL check.
  stashedAt: number;
}

// In-memory mirror of the stored value. It keeps the pre-persistence behaviour
// intact when SecureStore is unavailable: stashing still works for the life of
// the process, it just no longer outlives it.
let cached: StoredPendingDeepLink | null = null;

// A persisted URL is re-checked against the same gate that allowed it to be
// stashed, so a value that survived a schema change (or a link whose shape is
// no longer protected) is discarded instead of replayed.
function isReplayable(entry: StoredPendingDeepLink): boolean {
  return isJotSchemeUrl(entry.url) && isProtectedDeepLinkPath(getDeepLinkPath(entry.url));
}

function parseStored(raw: string): StoredPendingDeepLink | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const { url, stashedAt } = parsed as Partial<StoredPendingDeepLink>;
    if (typeof url !== 'string' || typeof stashedAt !== 'number' || !Number.isFinite(stashedAt)) {
      return null;
    }
    return { url, stashedAt };
  } catch {
    return null;
  }
}

export async function setPendingDeepLink(url: string): Promise<void> {
  cached = { url, stashedAt: Date.now() };
  try {
    await SecureStore.setItemAsync(PENDING_DEEP_LINK_KEY, JSON.stringify(cached));
  } catch {
    // Storage failure — the in-memory mirror still carries the link for this
    // process, which is all the pre-persistence implementation ever did.
  }
}

export async function clearPendingDeepLink(): Promise<void> {
  cached = null;
  try {
    await SecureStore.deleteItemAsync(PENDING_DEEP_LINK_KEY);
  } catch {
    // Storage failure — the TTL still bounds how long the orphaned value can
    // be replayed.
  }
}

// Returns the stashed URL, or null when there is none, it has expired, or it is
// no longer a link worth replaying. Anything it rejects is cleared, so a stale
// value is not re-read on the next call.
export async function getPendingDeepLink(): Promise<string | null> {
  let entry = cached;
  if (!entry) {
    try {
      const raw = await SecureStore.getItemAsync(PENDING_DEEP_LINK_KEY);
      entry = raw ? parseStored(raw) : null;
    } catch {
      return null;
    }
  }

  if (!entry) {
    return null;
  }

  if (Date.now() - entry.stashedAt > PENDING_DEEP_LINK_TTL_MS || !isReplayable(entry)) {
    await clearPendingDeepLink();
    return null;
  }

  cached = entry;
  return entry.url;
}
