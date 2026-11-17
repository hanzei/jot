// Merging queued ops that supersede each other, at enqueue (spec §8.5, #1268).
//
// The editor saves on a debounce, so an offline writing session would queue one
// full-content PATCH per pause in typing; repeated pins, reorders and item edits
// pile up the same way. Each would replay as its own request, and a conflict on
// the first would dead-letter every later one as a separate failed change.
// Instead, an op whose effect replaces an earlier queued one is written into
// that row.
//
// - Merged into the **last** queued op that shares a key with it (read-only
//   keys included: a duplicate copies its source, so an edit queued after it
//   must stay after it). Its position relative to every other op is unchanged.
// - Folded into the note's queued `create` when nothing queued after the create
//   depends on the fields it takes (see foldIntoCreate).
// - Never into the row the drain is sending: the drain records it
//   (claimQueueEntry in syncQueue.ts) in the serialized transaction that reads
//   it, and enqueueWrite passes it here, so a merge either lands before that
//   read or appends a new row.
// - Content and per-user fields stay in separate rows: content edits are
//   version-guarded and per-user fields are not, so a content conflict must not
//   take a pin or colour change down with it.
// - Opposite pairs (label add/remove, share/unshare) and ops of different types
//   are never merged.

import type { SQLiteDatabase } from 'expo-sqlite';
import { patchTouchesSharedContent, type UpdateNoteRequest } from '@jot/shared';
import { insertKeys, noteIdOfKey, noteKey, parseJsonObject } from './queueKeys';
import type { EnqueueParams, QueueOperation } from './syncQueue';

/** The fields an `update` body sets, leaving out its version guard. */
function updateFields(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter((field) => field !== 'base_version');
}

/**
 * An `update` body that changes only content (version-guarded), only per-user
 * fields, or both.
 */
function updateKind(body: Record<string, unknown>): 'content' | 'perUser' | 'mixed' {
  if (!patchTouchesSharedContent(body as UpdateNoteRequest)) return 'perUser';
  return updateFields(body).every((field) => field === 'title' || field === 'content') ? 'content' : 'mixed';
}

/** Whether two id lists name the same set of ids. */
function sameIdSet(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const left = new Set(a);
  return left.size === new Set(b).size && b.every((id) => left.has(id));
}

/** Whether id list `b` names every id in `a`. */
function coversIds(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const right = new Set(b);
  return a.every((id) => right.has(id));
}

type Merge = (queued: Record<string, unknown>, next: Record<string, unknown>) => Record<string, unknown> | null;

/**
 * The ops that can be merged, each with the body that replaces a queued row's
 * when a later op of the same operation and endpoint is merged into it; null
 * when the two must stay separate rows.
 */
const MERGES: Partial<Record<QueueOperation, Merge>> = {
  update: (queued, next) => {
    // Each save carries the whole text, and a per-user field's last value
    // wins, so the later fields replace the earlier ones.
    const kind = updateKind(next);
    if (kind === 'mixed' || updateKind(queued) !== kind) return null;
    if (kind === 'perUser') return { ...queued, ...next };
    // A merged content edit keeps the base of the first save it absorbed:
    // the version the text was edited from (spec §8.2). A row queued before
    // edits stored their base resolves it at replay; one with and one
    // without stay apart.
    if (('base_version' in queued) !== ('base_version' in next)) return null;
    return { ...queued, ...next, ...('base_version' in queued ? { base_version: queued.base_version } : {}) };
  },
  updateItem: (queued, next) => {
    // A null parent_id means "leave it unchanged", so it must not undo a
    // re-parent the queued row carries.
    const merged = { ...queued };
    for (const [field, value] of Object.entries(next)) {
      if (value !== null) merged[field] = value;
    }
    return merged;
  },
  setItemsCompleted: (queued, next) => (sameIdSet(queued.item_ids, next.item_ids) ? next : null),
  // The server sets each named note's position to its index, so the later
  // order replaces the earlier one only when it names every note that one
  // did: a reorder from a filtered view (a label, the archive) names a subset,
  // and the notes only the earlier one moved would keep their old server
  // positions.
  reorder: (queued, next) => (coversIds(queued.note_ids, next.note_ids) ? next : null),
  // Likewise per item.
  reorderItems: (queued, next) => (coversIds(queued.item_ids, next.item_ids) ? next : null),
};

interface QueuedRow {
  id: number;
  operation: string;
  endpoint: string;
  body: string | null;
}

/**
 * Queued row `row`'s body, when the row may be merged into: null for the row
 * the drain is sending, or a body that does not parse.
 */
function mergeableBody(row: QueuedRow | null, sendingEntryId: number | undefined): Record<string, unknown> | null {
  return row === null || row.id === sendingEntryId ? null : parseJsonObject(row.body);
}

/**
 * Write `op` into an earlier queued row it supersedes, inside the caller's
 * enqueue transaction. `sendingEntryId` is the row the drain is sending, which
 * is never merged into. Returns false when there is no such row, and the
 * caller inserts the op as a new row.
 */
export async function mergeQueuedOp(
  db: SQLiteDatabase,
  op: EnqueueParams,
  sendingEntryId: number | undefined,
): Promise<boolean> {
  const merge = MERGES[op.operation];
  if (!merge || !op.body) return false;
  if (op.operation === 'update' && await foldIntoCreate(db, op, op.body, sendingEntryId)) return true;

  const keys = [...new Set<string>([...op.keys, ...(op.readKeys ?? [])])];
  if (keys.length === 0) return false;
  const last = await db.getFirstAsync<QueuedRow>(
    `SELECT id, operation, endpoint, body FROM sync_queue
     WHERE id = (SELECT MAX(entry_id) FROM sync_queue_keys WHERE key IN (${keys.map(() => '?').join(', ')}))`,
    keys,
  );
  if (last?.operation !== op.operation || last.endpoint !== op.endpoint) return false;
  const queuedBody = mergeableBody(last, sendingEntryId);
  const body = queuedBody && merge(queuedBody, op.body);
  if (!body) return false;

  await rewriteBody(db, last.id, body);
  // The merged row touches what both ops touch. Only a reorder can name more
  // than the row did, and every note it names had no op queued after this
  // row (the lookup above).
  await insertKeys(db, 'sync_queue_keys', last.id, op);
  return true;
}

/**
 * Write a merged body into a queued row. The row now carries a new edit, so
 * the failures of the old payload are not held against it: its attempt count
 * and failure run start over, and it is given up on only once the new payload
 * has failed long enough on its own (#1301). Its wait stays, so editing a
 * note whose write keeps failing does not resend it on every save.
 */
async function rewriteBody(db: SQLiteDatabase, entryId: number, body: Record<string, unknown>): Promise<void> {
  await db.runAsync(
    `UPDATE sync_queue SET body = ?, attempts = 0, first_failed_at = NULL,
       spaced_failures = 0, last_spaced_failure_at = NULL
     WHERE id = ?`,
    [JSON.stringify(body), entryId],
  );
}

/** The fields of an `update` a create can take, whichever its note type. */
const CREATE_FIELDS: ReadonlySet<string> = new Set(['title', 'content', 'color', 'pinned']);

/**
 * Fold an `update` into its note's queued `create`, so the server receives one
 * create with the final fields (#1262). Only into a create the drain has never
 * sent: one whose response was lost may already be on the server, and its
 * replay resolves as already applied (409) without the folded fields. Only the
 * fields a create takes (its text, colour, pin), and only while nothing queued
 * after the create could see them change: a later `update` (one appended while the create was in flight)
 * would replay an older value over the folded one, a conversion is computed
 * from the text, and a duplicate copies the note.
 */
async function foldIntoCreate(
  db: SQLiteDatabase,
  op: EnqueueParams,
  body: Record<string, unknown>,
  sendingEntryId: number | undefined,
): Promise<boolean> {
  const noteId = op.keys.length === 1 ? noteIdOfKey(op.keys[0]!) : null; // an update writes exactly its note
  const fields = updateFields(body);
  // Settled without a query for the common case: an archive or collapse toggle.
  if (noteId === null || !fields.every((field) => CREATE_FIELDS.has(field))) return false;
  const key = noteKey(noteId);
  const create = await db.getFirstAsync<QueuedRow>(
    `SELECT q.id, q.operation, q.endpoint, q.body FROM sync_queue q
       JOIN sync_queue_keys k ON k.entry_id = q.id
     WHERE k.key = ? AND k.read_only = 0 AND q.operation = 'create' AND q.send_attempted = 0
     ORDER BY q.id DESC LIMIT 1`,
    [key],
  );
  const createBody = mergeableBody(create, sendingEntryId);
  if (create === null || createBody === null) return false;
  // A text note's create takes `content`, a list's `title`.
  const otherText = createBody.note_type === 'list' ? 'content' : 'title';
  if (fields.includes(otherText)) return false;

  const dependent = await db.getFirstAsync<{ found: number }>(
    `SELECT 1 AS found FROM sync_queue_keys k JOIN sync_queue q ON q.id = k.entry_id
     WHERE k.key = ? AND k.entry_id > ?
       AND (k.read_only = 1 OR q.operation IN ('update', 'convertNoteType'))
     LIMIT 1`,
    [key, create.id],
  );
  if (dependent !== null) return false;

  await rewriteBody(db, create.id, { ...createBody, ...Object.fromEntries(fields.map((field) => [field, body[field]])) });
  return true;
}
