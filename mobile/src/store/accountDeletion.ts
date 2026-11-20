import type { SQLiteDatabase } from 'expo-sqlite';
import type { DeleteAccountRequest } from '@jot/shared';
import { jot } from '../api/jot';
import { getActiveServerId } from '../api/client';
import { holdDrain } from '../db/syncQueue';
import { wipeLocalData } from '../db/accountOwner';

/**
 * Deletes the signed-in account on the server, then ends it on this device
 * like a deliberate logout (#1317, spec §8.6): local data wiped, session
 * forgotten, the server kept in the server list.
 *
 * A one-shot action, never a queued write (spec §4.3): the request goes out
 * while the user waits, with the API client's finite default timeout, and a
 * failure rejects with the request's error for the caller to show. Nothing has
 * changed on this device then.
 *
 * `db` is the active server's database, and `endSession` ends the session
 * without `POST /logout`, as the server already removed it
 * (`AuthContext.endSessionLocally`).
 */
export async function deleteAccount(
  db: SQLiteDatabase,
  body: DeleteAccountRequest,
  endSession: () => Promise<void>,
): Promise<void> {
  // Once the server has deleted the account, every queued write would only
  // 401. So the drain is held from before the request to after the wipe: a
  // pass already running finishes first, and its writes go out while the
  // session is still valid; none starts again until the queue is gone.
  const release = await holdDrain(db);
  // `db` is this server's database; read before the request, as a switch
  // meanwhile would change the active server.
  const serverId = getActiveServerId();
  try {
    await jot.users.deleteMe(body);
  } catch (err) {
    // The account still exists, and so does its queue: let it drain again.
    release({ resume: true });
    throw err;
  }

  try {
    // As on logout, wipe before ending the session, so the session never ends
    // with the data left behind on the success path.
    await wipeLocalData(db, serverId);
  } catch (error) {
    // Unlike logout, a failed wipe still ends the session: the account is
    // gone, so there is no session to keep the data with and nothing to retry.
    // The data is ownerless in effect. A failed wipe rolled back, so
    // `account_owner` still names the deleted user, an ID the server never
    // hands out again. Every later sign-in on this server goes through
    // AccountDataGate, whose `claimLocalData` wipes data owned by anyone
    // else before anything reads it or drains its queue. Until then the queue
    // has no session to send it with. (The app dying between the delete and
    // the wipe leaves the same state, once the launch's session check gets
    // its 401.)
    console.warn('Failed to wipe local data after deleting the account:', error);
  }

  try {
    await endSession();
  } finally {
    release();
  }
}
