import type { SQLiteDatabase } from 'expo-sqlite';

// The keys a queued operation touches, recorded when it is enqueued
// (`sync_queue_keys`) and carried over when it is dead-lettered
// (`dead_letter_keys`), so nothing has to parse an op's endpoint and body to
// find out which notes or labels it concerns (#1282).
//
// | Operation                                        | Keys                          |
// |--------------------------------------------------|-------------------------------|
// | note ops (create, update, items, share, …)       | note:<id>                     |
// | uploadImage, removeImage                         | note:<id>                     |
// | duplicate                                        | note:<clone>; note:<source> read-only |
// | reorder                                          | note:<id> per note named      |
// | addLabelToNote, removeLabelFromNote              | note:<id>, label:<id>         |
// | createLabel, renameLabel, deleteLabel            | label:<id>                    |
// | create naming labels                             | also label:<id> per label     |
// | updateSettings                                   | settings                      |
//
// A read-only key (`read_only = 1`) names something the op depends on but does
// not write: a duplicate copies its source on the server, so the source's
// queued writes must land first, yet the duplicate changes nothing in it. Such
// a key orders the op; it does not make the note protected, nor count as an op
// queued for it.

export type QueueKey = `note:${string}` | `label:${string}` | 'settings';

const NOTE_PREFIX = 'note:';
const LABEL_PREFIX = 'label:';

export function noteKey(noteId: string): QueueKey {
  return `${NOTE_PREFIX}${noteId}`;
}

export function labelKey(labelId: string): QueueKey {
  return `${LABEL_PREFIX}${labelId}`;
}

export const SETTINGS_KEY: QueueKey = 'settings';

/**
 * A SQL condition matching the keys of one kind in `column`, as a range rather
 * than a LIKE so the `key` index serves it. `;` sorts right after `:`.
 */
export function keyKindCondition(column: string, kind: 'note' | 'label'): string {
  return `${column} >= '${kind}:' AND ${column} < '${kind};'`;
}

/** The note id inside a `note:` key, or null for any other key. */
export function noteIdOfKey(key: string): string | null {
  return key.startsWith(NOTE_PREFIX) ? key.slice(NOTE_PREFIX.length) : null;
}

/** SQL expression for the id inside a key of `kind` held in `column`. */
export function keyIdExpression(column: string, kind: 'note' | 'label'): string {
  return `substr(${column}, ${kind.length + 2})`;
}

/** A stored JSON body as an object, or null when it is absent, unparseable or not an object. */
export function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** What an op touches: the keys it writes, and those it only reads. */
export interface OpKeys {
  keys: readonly QueueKey[];
  readKeys?: readonly QueueKey[] | undefined;
}

/**
 * Record an op's keys for row `rowId` of the queue (or dead letter) the key
 * table belongs to. A key in both lists is a written one.
 */
export async function insertKeys(
  db: SQLiteDatabase,
  table: 'sync_queue_keys' | 'dead_letter_keys',
  rowId: number,
  { keys, readKeys = [] }: OpKeys,
): Promise<void> {
  const column = table === 'sync_queue_keys' ? 'entry_id' : 'dead_letter_id';
  const written = new Set<string>(keys);
  const rows: [string, number][] = [
    ...[...written].map((key): [string, number] => [key, 0]),
    ...[...new Set<string>(readKeys)].filter((key) => !written.has(key)).map((key): [string, number] => [key, 1]),
  ];
  // One statement per chunk, well under SQLite's bound-parameter limit.
  for (let start = 0; start < rows.length; start += 300) {
    const chunk = rows.slice(start, start + 300);
    await db.runAsync(
      `INSERT OR IGNORE INTO ${table} (${column}, key, read_only) VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`,
      chunk.flatMap(([key, readOnly]) => [rowId, key, readOnly]),
    );
  }
}

/**
 * Label ids by lower-cased name, for {@link legacyQueueKeys}: every label in the
 * local store, plus the name each queued or dead-lettered `createLabel` was
 * created under. An op that names a label offline-created and since renamed
 * still carries the old name, which only the create's body remembers.
 */
export async function loadLabelIdsByName(db: SQLiteDatabase): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  const stored = await db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM labels');
  for (const row of stored) byName.set(row.name.toLowerCase(), row.id);
  for (const table of ['sync_queue', 'dead_letter']) {
    const creates = await db.getAllAsync<{ body: string | null }>(
      `SELECT body FROM ${table} WHERE operation = 'createLabel'`,
    );
    for (const row of creates) {
      const body = parseJsonObject(row.body);
      if (typeof body?.id !== 'string' || typeof body.name !== 'string') continue;
      const name = body.name.toLowerCase();
      // The store holds the current names; a create's only fills a gap.
      if (!byName.has(name)) byName.set(name, body.id);
    }
  }
  return byName;
}

/**
 * The keys of an op queued before keys were recorded, recovered from its
 * endpoint and body. Used only by the migration that backfills them (and by
 * test fixtures that seed rows the same way): new ops name their keys when
 * they are enqueued. Frozen with the endpoint shapes queued up to then.
 *
 * A label named only by name (the create's `labels`, `addLabelToNote`'s body)
 * is resolved through the local label store; a name it does not know adds no
 * label key.
 */
export function legacyQueueKeys(
  operation: string,
  endpoint: string,
  body: Record<string, unknown> | null,
  labelIdsByName: ReadonlyMap<string, string>,
): { keys: QueueKey[]; readKeys: QueueKey[] } {
  const keys = new Set<QueueKey>();
  const readKeys = new Set<QueueKey>();
  const segments = endpoint.split('?')[0]!.split('/').filter(Boolean);
  const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
  const addNote = (id: unknown): void => {
    const noteId = str(id);
    if (noteId) keys.add(noteKey(noteId));
  };
  const addLabel = (id: unknown): void => {
    const labelId = str(id);
    if (labelId) keys.add(labelKey(labelId));
  };
  const addLabelByName = (name: unknown): void => {
    const labelName = str(name);
    if (labelName) addLabel(labelIdsByName.get(labelName.toLowerCase()));
  };

  switch (operation) {
    case 'updateSettings':
      keys.add(SETTINGS_KEY);
      break;
    case 'removeImage':
      // DELETE /images/{id} names no note; the op carried it in its body.
      addNote(body?.note_id);
      break;
    case 'createLabel':
      addLabel(body?.id);
      break;
    case 'renameLabel':
    case 'deleteLabel':
      // /labels/{id}
      addLabel(segments[1]);
      break;
    case 'addLabelToNote':
    case 'removeLabelFromNote':
      // /notes/{id}/labels[/{labelId}]: the hook's add names the label in the
      // body, the local→server upgrade seed and the remove in the path.
      addNote(segments[1]);
      if (segments[3]) addLabel(segments[3]);
      else addLabelByName(body?.name);
      break;
    case 'create':
      addNote(body?.id);
      if (Array.isArray(body?.labels)) for (const name of body.labels) addLabelByName(name);
      break;
    case 'duplicate': {
      // /notes/{source}/duplicate: the clone is the client-supplied id; the
      // source is only read.
      addNote(body?.id);
      const sourceId = str(segments[1]);
      if (sourceId) readKeys.add(noteKey(sourceId));
      break;
    }
    case 'reorder':
      if (Array.isArray(body?.note_ids)) for (const id of body.note_ids) addNote(id);
      break;
    default:
      // /notes/{id}/…
      if (segments[0] === 'notes') addNote(segments[1]);
  }
  return { keys: [...keys], readKeys: [...readKeys] };
}
