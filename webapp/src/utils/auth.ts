import { ROLES, type User, type UserSettings } from '@jot/shared';
import { clearFailedRequests } from '@/utils/diagnostics';
import { API_CACHE, CLEAR_USER_DATA_MESSAGE, NOTE_IMAGES_CACHE } from '@/utils/serviceWorkerProtocol';

// How long sign-out waits for the service worker to confirm it emptied its
// queue. A worker that never answers must not leave the user stuck signed in.
const SERVICE_WORKER_REPLY_TIMEOUT_MS = 2000;

export const getUser = (): User | null => {
  const userStr = localStorage.getItem('user');
  if (!userStr) return null;
  try {
    return JSON.parse(userStr);
  } catch {
    return null;
  }
};

export const setUser = (user: User): void => {
  localStorage.setItem('user', JSON.stringify(user));
};

/**
 * Asks the active service worker to drop its background-sync queue and the
 * user's caches (see service-worker.ts). The queue lives in the worker's IndexedDB
 * database, which the worker keeps open, so the page cannot clear it itself.
 */
const clearServiceWorkerUserData = async (): Promise<void> => {
  const registration = await navigator.serviceWorker?.getRegistration();
  const worker = registration?.active;
  if (!worker) return;
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(resolve, SERVICE_WORKER_REPLY_TIMEOUT_MS);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve();
    };
    worker.postMessage({ type: CLEAR_USER_DATA_MESSAGE }, [channel.port2]);
  });
};

/**
 * Forgets the signed-in user on this device: their profile and settings, the
 * failed-request history, the cached API responses and note images, and any
 * writes the service worker queued while the server was unreachable — those
 * would otherwise be replayed with whoever's session cookie is current then.
 * Only for a session that is over: an outage keeps the user signed in (see
 * App.tsx), so their queued edits are still sent once the server is back.
 */
// The cleanup in flight, shared by overlapping calls (a burst of 401s from
// requests made with the same expired session).
let clearing: Promise<void> | null = null;

export const removeUser = (): Promise<void> => {
  localStorage.removeItem('user');
  localStorage.removeItem('settings');
  clearFailedRequests();
  clearing ??= (async () => {
    // The worker deletes the caches too; deleting them here as well covers a
    // page the worker does not control (e.g. after a hard reload).
    const cleanups: Promise<unknown>[] = [clearServiceWorkerUserData()];
    if (window.caches) {
      cleanups.push(caches.delete(API_CACHE), caches.delete(NOTE_IMAGES_CACHE));
    }
    // allSettled, not all: one failed cleanup must not resolve this before
    // the others have finished.
    await Promise.allSettled(cleanups);
  })().finally(() => { clearing = null; });
  return clearing;
};

export const getSettings = (): UserSettings | null => {
  const str = localStorage.getItem('settings');
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
};

export const setSettings = (settings: UserSettings): void => {
  localStorage.setItem('settings', JSON.stringify(settings));
};

export const isAuthenticated = (): boolean => {
  return !!getUser();
};

export const isAdmin = (): boolean => {
  const user = getUser();
  return !!(user && user.role === ROLES.ADMIN);
};
