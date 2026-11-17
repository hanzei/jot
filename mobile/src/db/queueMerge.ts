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
// - Never into the row the drain is sending: the drain marks it in flight
//   (markEntryInFlight) and re-reads it in the same serialized transaction, so
//   a merge either lands before that read or appends a new row.
// - Content and per-user fields stay in separate rows: content edits are
//   version-guarded and per-user fields are not, so a content conflict must not
//   take a pin or colour change down with it.
// - Opposite pairs (label add/remove, share/unshare) and ops of different types
//   are never merged.

import type { SQLiteDatabase } from 'expo-sqlite';
import { insertKeys, noteIdOfKey, noteKey, parseJsonObject } from './queueKeys';
import type { EnqueueParams } from './syncQueue';

// The row the drain is sending, per database. One drain pass runs at a time.
const inFlightByDb = new WeakMap<SQLiteDatabase, number>();

/**
 * Mark queue row `entryId` as being sent: nothing merges into it until
 * {@link clearEntryInFlight}. Call it in the serialized transaction that reads
 * the row the drain sends.
 */
export function markEntryInFlight(db: SQLiteDatabase, entryId: number): void {
  inFlightByDb.set(db, entryId);
}

/** The drain is done with the row it marked in flight. */
export function clearEntryInFlight(db: SQLiteDatabase): void {
  inFlightByDb.delete(db);
}

const CONTENT_FIELDS: ReadonlySet<string> = new Set(['title', 'content']);
const PER_USER_FIELDS: ReadonlySet<string> = new Set(['pinned', 'color', 'archived', 'checked_items_collapsed']);

/** An `update` body that changes only content, only per-user fields, or both. */
function updateKind(body: Record<string, unknown>): 'content' | 'perUser' | 'mixed' {
  const fields = Object.keys(body).filter((field) => field !== 'base_version');
  if (fields.length > 0 && fields.every((field) => CONTENT_FIELDS.has(field))) return 'content';
  if (fields.length > 0 && fields.every((field) => PER_USER_FIELDS.has(field))) return 'perUser';
  return 'mixed';
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

/**
 * The body that replaces `queued`'s when `next`, an op of the same operation
 * and endpoint, is merged into it; null when the two must stay separate rows.
 */
function mergedBody(
  operation: EnqueueParams['operation'],
  queued: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> | null {
  switch (operation) {
    case 'update': {
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
      const merged = { ...queued, ...next };
      if ('base_version' in queued) merged.base_version = queued.base_version;
      return merged;
    }
    case 'updateItem': {
      // A null parent_id means "leave it unchanged", so it must not undo a
      // re-parent the queued row carries.
      const merged = { ...queued };
      for (const [field, value] of Object.entries(next)) {
        if (value !== null) merged[field] = value;
      }
      return merged;
    }
    case 'setItemsCompleted':
      return sameIdSet(queued.item_ids, next.item_ids) ? next : null;
    case 'reorder':
      // The server sets each named note's position to its index, so the later
      // order replaces the earlier one only when it names every note that one
      // did: a reorder from a filtered view (a label, the archive) names a
      // subset, and the notes only the earlier one moved would keep their old
      // server positions.
      return coversIds(queued.note_ids, next.note_ids) ? next : null;
    case 'reorderItems':
      // Likewise per item.
      return coversIds(queued.item_ids, next.item_ids) ? next : null;
    default:
      return null;
  }
}

const MERGEABLE_OPERATIONS: ReadonlySet<EnqueueParams['operation']> = new Set([
  'update',
  'updateItem',
  'setItemsCompleted',
  'reorder',
  'reorderItems',
]);

interface QueuedRow {
  id: number;
  operation: string;
  endpoint: string;
  body: string | null;
}

/**
 * Write `op` into an earlier queued row it supersedes, inside the caller's
 * enqueue transaction. Returns false when there is none, and the caller
 * inserts the op as a new row.
 */
export async function mergeQueuedOp(db: SQLiteDatabase, op: EnqueueParams): Promise<boolean> {
  if (!MERGEABLE_OPERATIONS.has(op.operation) || !op.body) return false;
  if (op.operation === 'update' && await foldIntoCreate(db, op, op.body)) return true;

  const keys = [...new Set<string>([...op.keys, ...(op.readKeys ?? [])])];
  if (keys.length === 0) return false;
  const last = await db.getFirstAsync<QueuedRow>(
    `SELECT id, operation, endpoint, body FROM sync_queue
     WHERE id = (SELECT MAX(entry_id) FROM sync_queue_keys WHERE key IN (${keys.map(() => '?').join(', ')}))`,
    keys,
  );
  if (last === null || inFlightByDb.get(db) === last.id) return false;
  if (last.operation !== op.operation || last.endpoint !== op.endpoint) return false;
  const queuedBody = parseJsonObject(last.body);
  if (queuedBody === null) return false;
  const body = mergedBody(op.operation, queuedBody, op.body);
  if (body === null) return false;

  await db.runAsync('UPDATE sync_queue SET body = ? WHERE id = ?', [JSON.stringify(body), last.id]);
  if (op.operation === 'reorder') {
    // A later reorder may name other notes. Every note it names had no op
    // queued after this row (the lookup above), so the row can take its keys.
    await db.runAsync('DELETE FROM sync_queue_keys WHERE entry_id = ?', [last.id]);
    await insertKeys(db, 'sync_queue_keys', last.id, op);
  }
  return true;
}

/**
 * Fold an `update` into its note's queued `create`, so the server receives one
 * create with the final fields (#1262). Only the fields a create takes (its
 * text, colour, pin) and only while nothing queued after the create could see
 * them change: a later `update` (one appended while the create was in flight)
 * would replay an older value over the folded one, a conversion is computed
 * from the text, and a duplicate copies the note.
 */
async function foldIntoCreate(db: SQLiteDatabase, op: EnqueueParams, body: Record<string, unknown>): Promise<boolean> {
  const noteId = op.keys.length === 1 ? noteIdOfKey(op.keys[0]!) : null; // an update writes exactly its note
  if (noteId === null) return false;
  const key = noteKey(noteId);
  const create = await db.getFirstAsync<QueuedRow>(
    `SELECT q.id, q.operation, q.endpoint, q.body FROM sync_queue q
       JOIN sync_queue_keys k ON k.entry_id = q.id
     WHERE k.key = ? AND k.read_only = 0 AND q.operation = 'create'
     ORDER BY q.id DESC LIMIT 1`,
    [key],
  );
  if (create === null || inFlightByDb.get(db) === create.id) return false;
  const createBody = parseJsonObject(create.body);
  if (createBody === null) return false;

  const textField = createBody.note_type === 'list' ? 'title' : 'content';
  const fields = Object.entries(body).filter(([field]) => field !== 'base_version');
  if (!fields.every(([field]) => field === textField || field === 'color' || field === 'pinned')) return false;

  const dependent = await db.getFirstAsync<{ found: number }>(
    `SELECT 1 AS found FROM sync_queue_keys k JOIN sync_queue q ON q.id = k.entry_id
     WHERE k.key = ? AND k.entry_id > ?
       AND (k.read_only = 1 OR q.operation IN ('update', 'convertNoteType'))
     LIMIT 1`,
    [key, create.id],
  );
  if (dependent !== null) return false;

  await db.runAsync(
    'UPDATE sync_queue SET body = ? WHERE id = ?',
    [JSON.stringify({ ...createBody, ...Object.fromEntries(fields) }), create.id],
  );
  return true;
}
