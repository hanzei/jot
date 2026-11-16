import type { SQLiteDatabase } from 'expo-sqlite';

// The keys a queued operation touches, recorded when it is enqueued
// (`sync_queue_keys`) and carried over when it is dead-lettered
// (`dead_letter_keys`), so nothing has to parse an op's endpoint and body to
// find out which notes or labels it concerns (#1282).
//
// | Operation                                        | Keys                          |
// |--------------------------------------------------|-------------------------------|
// | note ops (create, update, items, share, …)       | note:<id>                     |
// | duplicate                                        | note:<clone>, note:<source>   |
// | reorder                                          | note:<id> per note named      |
// | addLabelToNote, removeLabelFromNote              | note:<id>, label:<id>         |
// | createLabel, renameLabel, deleteLabel            | label:<id>                    |
// | create naming labels                             | also label:<id> per label     |
// | updateSettings                                   | settings                      |

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

/** SQL expression for the id inside a key of `kind` held in `column`. */
export function keyIdExpression(column: string, kind: 'note' | 'label'): string {
  return `substr(${column}, ${kind.length + 2})`;
}

/** The note ids among `keys`. */
export function noteIdsOf(keys: Iterable<string>): string[] {
  const ids: string[] = [];
  for (const key of keys) {
    if (key.startsWith(NOTE_PREFIX)) ids.push(key.slice(NOTE_PREFIX.length));
  }
  return ids;
}

/** Record `keys` for row `rowId` of the queue (or dead letter) the key table belongs to. */
export async function insertKeys(
  db: SQLiteDatabase,
  table: 'sync_queue_keys' | 'dead_letter_keys',
  rowId: number,
  keys: Iterable<string>,
): Promise<void> {
  const column = table === 'sync_queue_keys' ? 'entry_id' : 'dead_letter_id';
  for (const key of new Set(keys)) {
    await db.runAsync(`INSERT OR IGNORE INTO ${table} (${column}, key) VALUES (?, ?)`, [rowId, key]);
  }
}

/** Every local label's id by its lower-cased name, for {@link legacyQueueKeys}. */
export async function loadLabelIdsByName(db: SQLiteDatabase): Promise<Map<string, string>> {
  const rows = await db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM labels');
  return new Map(rows.map((row) => [row.name.toLowerCase(), row.id]));
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
): QueueKey[] {
  const keys = new Set<QueueKey>();
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
    case 'duplicate':
      // /notes/{source}/duplicate: the clone is the client-supplied id.
      addNote(body?.id);
      addNote(segments[1]);
      break;
    case 'reorder':
      if (Array.isArray(body?.note_ids)) for (const id of body.note_ids) addNote(id);
      break;
    default:
      // /notes/{id}/…
      if (segments[0] === 'notes') addNote(segments[1]);
  }
  return [...keys];
}
