import * as SecureStore from 'expo-secure-store';
import type { User, UserSettings } from '@jot/shared';
import { generateId, ROLES } from '@jot/shared';

/**
 * Local ("serverless") mode lets the app run as a single-user, on-device note
 * store without ever talking to a Jot server (epic #511). This module owns the
 * persisted local-mode flag and the local-only user identity that stands in for
 * the server-issued profile.
 *
 * The flag and identity live together in a single SecureStore record: the
 * presence of the record *is* the flag. Local mode is a first-class persistent
 * state, not a temporary offline fallback — once enabled it survives app
 * restarts until the user explicitly leaves it (see `disableLocalMode`).
 */

const LOCAL_MODE_KEY = 'jot_local_mode_v1';

// Serialize all writes/deletes of LOCAL_MODE_KEY so updateLocalSettings cannot
// recreate the identity record after disableLocalMode has deleted it.
let keyMutationChain: Promise<unknown> = Promise.resolve();

function withKeyMutationLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = keyMutationChain.then(fn);
  // Swallow errors on the shared chain so one failure doesn't block subsequent ops.
  keyMutationChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** The default username for the on-device identity. Display-only; never sent anywhere. */
const LOCAL_USERNAME = 'local';

/**
 * Synchronous mirror of the persisted local-mode flag, kept in lockstep with
 * AuthContext's `isLocalMode` state (see AuthProvider). The persisted record is
 * the source of truth, but reading it is async (SecureStore); the sync queue,
 * the offline drain loop, the SSE manager, and the write hooks need a *synchronous*
 * answer to short-circuit all server/sync machinery while local mode is active
 * (epic #511, issue #514). It is intentionally a single module-global: there is
 * exactly one active identity per app process.
 */
let localModeActive = false;

/** True when the app is currently running in serverless local mode. */
export function isLocalModeActive(): boolean {
  return localModeActive;
}

/**
 * Update the synchronous local-mode flag. Driven by AuthContext whenever its
 * `isLocalMode` state changes, so every synchronous reader stays consistent with
 * the authenticated session.
 */
export function setLocalModeActive(active: boolean): void {
  localModeActive = active;
}

export interface LocalIdentity {
  user: User;
  settings: UserSettings;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Provision a fresh local identity. The user ID uses the server-compatible 22-char
 * format so a future "connect to a server" upgrade path (epic #511) can adopt the
 * locally generated ID as a server primary key without reconciliation.
 */
function createLocalIdentity(): LocalIdentity {
  const id = generateId();
  const timestamp = nowIso();
  return {
    user: {
      id,
      username: LOCAL_USERNAME,
      first_name: '',
      last_name: '',
      role: ROLES.USER,
      has_profile_icon: false,
      created_at: timestamp,
      updated_at: timestamp,
    },
    settings: {
      user_id: id,
      language: 'en',
      theme: 'system',
      note_sort: 'manual',
      updated_at: timestamp,
    },
  };
}

function isLocalIdentity(value: unknown): value is LocalIdentity {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { user?: unknown; settings?: unknown };
  const user = candidate.user as { id?: unknown } | undefined;
  const settings = candidate.settings as { user_id?: unknown } | undefined;
  return (
    !!user &&
    typeof user.id === 'string' &&
    !!settings &&
    typeof settings.user_id === 'string'
  );
}

/**
 * Return the persisted local identity, or null when local mode is not enabled.
 * Used by `AuthContext` on startup to land the user directly in the notes UI,
 * bypassing the login/register flow and the `GET /me` session restore.
 */
export async function getLocalIdentity(): Promise<LocalIdentity | null> {
  const raw = await SecureStore.getItemAsync(LOCAL_MODE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isLocalIdentity(parsed)) {
      return parsed;
    }
  } catch {
    // Corrupt record: fall through and treat local mode as disabled.
  }
  return null;
}

/** True when local mode is currently enabled (a valid identity is persisted). */
export async function isLocalModeEnabled(): Promise<boolean> {
  return (await getLocalIdentity()) !== null;
}

/**
 * Enable local mode, provisioning and persisting a local identity on first use.
 * Idempotent: if local mode is already enabled, the existing identity is
 * returned so the user's stable ID is preserved across calls.
 */
export async function enableLocalMode(): Promise<LocalIdentity> {
  const existing = await getLocalIdentity();
  if (existing) {
    return existing;
  }
  const identity = createLocalIdentity();
  await SecureStore.setItemAsync(LOCAL_MODE_KEY, JSON.stringify(identity));
  return identity;
}

/** Disable local mode and drop the persisted identity. */
export function disableLocalMode(): Promise<void> {
  return withKeyMutationLock(() => SecureStore.deleteItemAsync(LOCAL_MODE_KEY));
}

/**
 * Persist updated settings into the local identity so they survive app restarts
 * (issue #516). No-op when local mode is not enabled (the identity record is absent).
 * Serialized with disableLocalMode() so a concurrent logout cannot leave a
 * stale record behind after the key has been deleted.
 */
export function updateLocalSettings(newSettings: UserSettings): Promise<void> {
  return withKeyMutationLock(async () => {
    const raw = await SecureStore.getItemAsync(LOCAL_MODE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isLocalIdentity(parsed)) return;
      await SecureStore.setItemAsync(LOCAL_MODE_KEY, JSON.stringify({ ...parsed, settings: newSettings }));
    } catch {
      // Corrupt record: silently ignore; the new settings stay in memory.
    }
  });
}
