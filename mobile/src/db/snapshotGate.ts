import { collectNoteIds } from './affectedNoteIds';
import { parseJsonObject } from './queueKeys';

// A server snapshot (a GET /notes list, a GET /notes/{id}, an SSE payload)
// reflects the server as of when it was built, which can be before one of this
// device's own writes landed. The queue gate (getProtectedNoteIds) covers a
// write until its queue row is deleted; this covers the rest of the window:
// once the write has landed and its row is gone, a snapshot started before the
// landing still predates it, and saving it would roll the note back (#1265).
//
// So each writer takes a mark before it fetches, and the save skips every note
// a write landed on since that mark. The counter is local and monotonic, so no
// server/device clock comparison is involved. It lives in memory only: a
// restart drops every snapshot in flight along with it.

/** Opaque position in the landing sequence; take one before fetching a snapshot. */
export type SnapshotMark = number;

let landingSeq = 0;
const lastLandingByNote = new Map<string, number>();

/** The current mark. Take it before the request whose response will be saved. */
export function snapshotMark(): SnapshotMark {
  return landingSeq;
}

/** Record that a write on `noteIds` has landed on the server. */
export function recordWriteLanded(noteIds: Iterable<string>): void {
  landingSeq++;
  for (const id of noteIds) lastLandingByNote.set(id, landingSeq);
}

/** Notes a write landed on after `mark` was taken: a snapshot from `mark` is stale for them. */
export function notesWrittenSince(mark: SnapshotMark): Set<string> {
  const ids = new Set<string>();
  if (mark === landingSeq) return ids;
  for (const [id, seq] of lastLandingByNote) {
    if (seq > mark) ids.add(id);
  }
  return ids;
}

/**
 * Called by the API client for every successful non-GET request: records the
 * notes it wrote. Covers the queue drain's replays and the one-shot writes
 * with no queue alike, since both go through the same axios instance.
 */
export function recordWriteResponse(method: string | undefined, url: string | undefined, data: unknown): void {
  if (!url || !method || method.toLowerCase() === 'get') return;
  // POST /notes/{id}/viewed only marks the note read. It fires as the editor
  // opens, alongside the note's own refresh, which it must not hold back.
  if (url.split('?')[0]!.endsWith('/viewed')) return;
  const ids = collectNoteIds(url, parseRequestBody(data));
  if (ids.size > 0) recordWriteLanded(ids);
}

// axios has already serialized a JSON body to a string by the time the
// response interceptor sees the request config.
function parseRequestBody(data: unknown): Record<string, unknown> | null {
  if (typeof data === 'string') return parseJsonObject(data);
  return data !== null && typeof data === 'object' ? data as Record<string, unknown> : null;
}

