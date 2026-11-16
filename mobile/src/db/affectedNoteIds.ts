// Which notes a write touches, recovered from its URL and body. Used by the
// write-landing gate (snapshotGate.ts), which sees every request the API client
// sends. Queued ops record what they touch when they are enqueued instead
// (queueKeys.ts, #1282).

/**
 * Add the note IDs a request writes (identified by its URL and already-parsed
 * body) to `ids`. Requests that write no note (labels, settings, image deletes)
 * contribute nothing.
 */
export function collectNoteIds(
  endpoint: string,
  body: Record<string, unknown> | null,
  ids: Set<string>,
): void {
  // Drop any query string (e.g. "/notes/{id}?permanent=true") before splitting,
  // and filter out the empty segment from the leading slash.
  const segments = endpoint.split('?')[0]!.split('/').filter(Boolean);
  if (segments[0] !== 'notes') return;

  if (segments.length === 1) {
    // POST /notes (create): the affected note is the offline-created note, identified
    // by the client-supplied `id` (issue #475).
    const createId = body?.id;
    if (typeof createId === 'string') ids.add(createId);
  } else if (segments[1] === 'reorder') {
    // POST /notes/reorder: body.note_ids lists every note whose position moved.
    const noteIds = body?.note_ids;
    if (Array.isArray(noteIds)) {
      for (const id of noteIds) if (typeof id === 'string') ids.add(id);
    }
  } else {
    // POST /notes/{id}/duplicate creates a local clone: the write belongs to the
    // clone, not the source note (which it only reads), so track just the new
    // note id via the client-supplied `id`.
    if (segments.length === 3 && segments[2] === 'duplicate') {
      const dupId = body?.id;
      if (typeof dupId === 'string') ids.add(dupId);
    } else {
      ids.add(segments[1]!);
    }
  }
}
