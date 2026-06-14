import { SQLiteDatabase } from 'expo-sqlite';
import type { Note, NoteItem, GetNotesParams, Label, NoteShare } from '@jot/shared';
import { getRandomBytes, getStrongRandomBytes } from '../utils/random';

interface NoteRow {
  id: string;
  user_id: string;
  title: string;
  content: string;
  note_type: string;
  color: string;
  pinned: number;
  archived: number;
  position: number;
  checked_items_collapsed: number;
  is_shared: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  labels_json: string;
  shared_with_json: string;
}

interface NoteItemRow {
  id: string;
  note_id: string;
  text: string;
  completed: number;
  position: number;
  parent_id: string | null;
  assigned_to: string;
  created_at: string;
  updated_at: string;
}

function rowToNote(row: NoteRow, items: NoteItem[] = []): Note {
  let labels: Label[] = [];
  let shared_with: NoteShare[] = [];
  try { labels = JSON.parse(row.labels_json) as Label[]; } catch { /* ignore */ }
  try { shared_with = JSON.parse(row.shared_with_json) as NoteShare[]; } catch { /* ignore */ }
  const base = {
    id: row.id,
    user_id: row.user_id,
    color: row.color,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    position: row.position,
    is_shared: row.is_shared === 1,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    labels,
    shared_with,
  };
  if (row.note_type === 'list') {
    return {
      ...base,
      note_type: 'list',
      title: row.title,
      checked_items_collapsed: row.checked_items_collapsed === 1,
      items,
    };
  }
  return {
    ...base,
    note_type: 'text',
    content: row.content,
  };
}

function itemRowToNoteItem(row: NoteItemRow): NoteItem {
  return {
    id: row.id,
    note_id: row.note_id,
    text: row.text,
    completed: row.completed === 1,
    position: row.position,
    parent_id: row.parent_id ?? null,
    assigned_to: row.assigned_to ?? '',
    created_at: row.created_at ?? '',
    updated_at: row.updated_at ?? '',
  };
}

async function getItemsForNote(db: SQLiteDatabase, noteId: string): Promise<NoteItem[]> {
  const rows = await db.getAllAsync<NoteItemRow>(
    'SELECT * FROM note_items WHERE note_id = ? ORDER BY position ASC',
    [noteId],
  );
  return rows.map(itemRowToNoteItem);
}

// Writes a single note (and its items if provided) without wrapping in a transaction.
// Must only be called from within an existing transaction context.
async function saveNoteInTx(db: SQLiteDatabase, note: Note): Promise<void> {
  const title = note.note_type === 'list' ? note.title : '';
  const content = note.note_type === 'text' ? note.content : '';
  const checkedItemsCollapsed = note.note_type === 'list' ? (note.checked_items_collapsed ? 1 : 0) : 0;
  const items = note.note_type === 'list' ? note.items : undefined;

  await db.runAsync(
    `INSERT OR REPLACE INTO notes
       (id, user_id, title, content, note_type, color, pinned, archived, position,
        checked_items_collapsed, is_shared, deleted_at, created_at, updated_at,
        labels_json, shared_with_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      note.id,
      note.user_id,
      title,
      content,
      note.note_type,
      note.color,
      note.pinned ? 1 : 0,
      note.archived ? 1 : 0,
      note.position,
      checkedItemsCollapsed,
      note.is_shared ? 1 : 0,
      note.deleted_at ?? null,
      note.created_at,
      note.updated_at,
      JSON.stringify(note.labels ?? []),
      JSON.stringify(note.shared_with ?? []),
    ],
  );

  if (items !== undefined) {
    await db.runAsync('DELETE FROM note_items WHERE note_id = ?', [note.id]);
    for (const item of items) {
      await db.runAsync(
        `INSERT OR REPLACE INTO note_items (id, note_id, text, completed, position, parent_id, assigned_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [item.id, note.id, item.text, item.completed ? 1 : 0, item.position, item.parent_id ?? null, item.assigned_to ?? '', item.created_at ?? '', item.updated_at ?? ''],
      );
    }
  }
}

/**
 * `skipNoteIds` lists notes that must be left untouched (those with a pending
 * sync-queue op). Server-sourced writes go through `saveServerNote`/`saveServerNotes`
 * in syncQueue.ts, which populate this from the queue (see issue #487).
 */
interface SaveNoteOptions {
  skipNoteIds?: ReadonlySet<string>;
}

export async function saveNote(db: SQLiteDatabase, note: Note, options?: SaveNoteOptions): Promise<void> {
  if (options?.skipNoteIds?.has(note.id)) return;
  await db.withTransactionAsync(() => saveNoteInTx(db, note));
}

export async function saveNotes(db: SQLiteDatabase, notes: Note[], options?: SaveNoteOptions): Promise<void> {
  const skipNoteIds = options?.skipNoteIds;
  await db.withTransactionAsync(async () => {
    for (const note of notes) {
      if (skipNoteIds?.has(note.id)) continue;
      await saveNoteInTx(db, note);
    }
  });
}

export async function getLocalNotes(db: SQLiteDatabase, params?: GetNotesParams): Promise<Note[]> {
  let sql = 'SELECT * FROM notes WHERE 1=1';
  const args: (string | number | null)[] = [];

  if (params?.my_tasks) {
    if (!params.user_id) return [];
    sql += ' AND deleted_at IS NULL AND id IN (SELECT note_id FROM note_items WHERE assigned_to = ?)';
    args.push(params.user_id);
  } else if (params?.archived) {
    sql += ' AND archived = 1 AND deleted_at IS NULL';
  } else if (params?.trashed) {
    sql += ' AND deleted_at IS NOT NULL';
  } else {
    sql += ' AND archived = 0 AND deleted_at IS NULL';
  }

  if (params?.search) {
    sql += ' AND ((note_type = \'list\' AND title LIKE ?) OR (note_type = \'text\' AND content LIKE ?))';
    args.push(`%${params.search}%`, `%${params.search}%`);
  }

  sql += ' ORDER BY pinned DESC, position ASC';
  const rows = await db.getAllAsync<NoteRow>(sql, args);

  if (rows.length === 0) return [];

  // Batch-fetch all note_items for list notes in a single query (avoids N+1)
  const listIds = rows.filter((r) => r.note_type === 'list').map((r) => r.id);
  const itemsByNoteId = new Map<string, NoteItem[]>();
  if (listIds.length > 0) {
    const placeholders = listIds.map(() => '?').join(', ');
    const itemRows = await db.getAllAsync<NoteItemRow>(
      `SELECT * FROM note_items WHERE note_id IN (${placeholders}) ORDER BY note_id ASC, position ASC`,
      listIds,
    );
    for (const itemRow of itemRows) {
      const existing = itemsByNoteId.get(itemRow.note_id) ?? [];
      existing.push(itemRowToNoteItem(itemRow));
      itemsByNoteId.set(itemRow.note_id, existing);
    }
  }

  // Convert rows to Notes (rowToNote parses labels_json), then apply label filter
  const notes = rows.map((row) => rowToNote(row, itemsByNoteId.get(row.id) ?? []));
  if (params?.label) {
    return notes.filter((n) => n.labels.some((l) => l.id === params.label));
  }
  return notes;
}

export async function getLocalNote(db: SQLiteDatabase, id: string): Promise<Note | null> {
  const row = await db.getFirstAsync<NoteRow>('SELECT * FROM notes WHERE id = ?', [id]);
  if (!row) return null;
  const items = row.note_type === 'list' ? await getItemsForNote(db, id) : [];
  return rowToNote(row, items);
}

export async function markLocalNoteDeleted(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync(
    'UPDATE notes SET deleted_at = ? WHERE id = ?',
    [new Date().toISOString(), id],
  );
}

/**
 * Mark a note as having an unsynced write the server permanently rejected
 * (a dead-lettered op; see issue #492). The local row is the version we preserve,
 * so {@link getFailedNoteIds} keeps it from being overwritten or pruned by a
 * background fetch / SSE event until the failure is resolved. No-op if the note
 * no longer exists locally.
 */
export async function markNoteSyncFailed(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync(`UPDATE notes SET sync_state = 'failed' WHERE id = ?`, [id]);
}

/**
 * Clear a note's failed sync state back to 'synced'. Called when a later queued
 * op for the note drains successfully, so a recovered note resumes syncing from
 * the server normally. Guarded on the current state so it never touches a
 * non-failed row.
 */
export async function clearNoteSyncFailed(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync(`UPDATE notes SET sync_state = 'synced' WHERE id = ? AND sync_state = 'failed'`, [id]);
}

/** IDs of notes currently flagged `sync_state = 'failed'` (see {@link markNoteSyncFailed}). */
export async function getFailedNoteIds(db: SQLiteDatabase): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ id: string }>(`SELECT id FROM notes WHERE sync_state = 'failed'`);
  return new Set(rows.map((r) => r.id));
}

/**
 * Flag an offline-created note as not yet confirmed by the server. Its
 * client-generated ID is already a server-valid primary key (see
 * {@link generateClientNoteId}), so the note carries a normal ID; this marker is
 * what tells the UI it isn't on the server yet — gating actions that need a
 * server-side note (sharing, label management) until the queued create drains
 * (issue #475).
 */
export async function markNotePendingCreate(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync(`UPDATE notes SET sync_state = 'pending' WHERE id = ?`, [id]);
}

/**
 * Clear a note's pending-create marker back to 'synced'. Called when its queued
 * create drains (success or an idempotent 409 — the note already exists on the
 * server either way). Guarded on the current state so it never touches a
 * non-pending row.
 */
export async function clearNotePendingCreate(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync(`UPDATE notes SET sync_state = 'synced' WHERE id = ? AND sync_state = 'pending'`, [id]);
}

/** IDs of notes whose offline create has not yet been confirmed by the server. */
export async function getPendingCreateNoteIds(db: SQLiteDatabase): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ id: string }>(`SELECT id FROM notes WHERE sync_state = 'pending'`);
  return new Set(rows.map((r) => r.id));
}

/**
 * Authoritative single-note check used by write mutations: is this note an
 * offline create the server hasn't confirmed yet (#475)? Reads the row directly
 * so the guard can't act on a stale in-memory set.
 */
export async function isNotePendingCreate(db: SQLiteDatabase, id: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ sync_state: string }>(
    `SELECT sync_state FROM notes WHERE id = ?`,
    [id],
  );
  return row?.sync_state === 'pending';
}

export async function markLocalNoteRestored(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync(
    'UPDATE notes SET deleted_at = NULL, archived = 0 WHERE id = ?',
    [id],
  );
}

export async function permanentDeleteLocalNote(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM notes WHERE id = ?', [id]);
}

interface LocalNoteChanges {
  title?: string;
  content?: string;
  pinned?: boolean;
  archived?: boolean;
  color?: string;
  checked_items_collapsed?: boolean;
  position?: number;
}

export async function updateLocalNote(
  db: SQLiteDatabase,
  id: string,
  changes: LocalNoteChanges,
): Promise<void> {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (changes.title !== undefined) { fields.push('title = ?'); values.push(changes.title); }
  if (changes.content !== undefined) { fields.push('content = ?'); values.push(changes.content); }
  if (changes.pinned !== undefined) { fields.push('pinned = ?'); values.push(changes.pinned ? 1 : 0); }
  if (changes.archived !== undefined) { fields.push('archived = ?'); values.push(changes.archived ? 1 : 0); }
  if (changes.color !== undefined) { fields.push('color = ?'); values.push(changes.color); }
  if (changes.position !== undefined) { fields.push('position = ?'); values.push(changes.position); }
  if (changes.checked_items_collapsed !== undefined) {
    fields.push('checked_items_collapsed = ?');
    values.push(changes.checked_items_collapsed ? 1 : 0);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  await db.runAsync(`UPDATE notes SET ${fields.join(', ')} WHERE id = ?`, values);
}

export async function renameLabelInLocalNotes(
  db: SQLiteDatabase,
  labelId: string,
  name: string,
): Promise<void> {
  const rows = await db.getAllAsync<Pick<NoteRow, 'id' | 'labels_json'>>(
    'SELECT id, labels_json FROM notes',
  );

  await db.withTransactionAsync(async () => {
    for (const row of rows) {
      let labels: Label[] = [];
      try {
        labels = JSON.parse(row.labels_json) as Label[];
      } catch {
        continue;
      }

      let changed = false;
      const nextLabels = labels.map((label) => {
        if (label.id !== labelId || label.name === name) {
          return label;
        }
        changed = true;
        return { ...label, name };
      });

      if (!changed) {
        continue;
      }

      await db.runAsync(
        'UPDATE notes SET labels_json = ?, updated_at = ? WHERE id = ?',
        [JSON.stringify(nextLabels), new Date().toISOString(), row.id],
      );
    }
  });
}

/**
 * Read a single note's labels, apply `transform`, and persist the result. The
 * write is skipped when `transform` returns `null` (no change), keeping the
 * helper idempotent. Used by the offline add/remove-label-on-note paths.
 */
async function updateNoteLabels(
  db: SQLiteDatabase,
  noteId: string,
  transform: (labels: Label[]) => Label[] | null,
): Promise<void> {
  const row = await db.getFirstAsync<Pick<NoteRow, 'labels_json'>>(
    'SELECT labels_json FROM notes WHERE id = ?',
    [noteId],
  );
  if (!row) return;

  let labels: Label[] = [];
  try {
    labels = JSON.parse(row.labels_json) as Label[];
  } catch {
    labels = [];
  }

  const nextLabels = transform(labels);
  if (nextLabels === null) return;

  await db.runAsync(
    'UPDATE notes SET labels_json = ?, updated_at = ? WHERE id = ?',
    [JSON.stringify(nextLabels), new Date().toISOString(), noteId],
  );
}

export async function addLabelToLocalNote(
  db: SQLiteDatabase,
  noteId: string,
  label: Label,
): Promise<void> {
  await updateNoteLabels(db, noteId, (labels) => {
    // Idempotent: skip if the note already carries this label (by id, or by name
    // case-insensitively to mirror the server's GetOrCreateLabel lookup).
    const normalizedName = label.name.toLowerCase();
    if (labels.some((l) => l.id === label.id || l.name.toLowerCase() === normalizedName)) return null;
    return [...labels, label];
  });
}

export async function removeLabelFromLocalNote(
  db: SQLiteDatabase,
  noteId: string,
  labelId: string,
): Promise<void> {
  await updateNoteLabels(db, noteId, (labels) => {
    const nextLabels = labels.filter((label) => label.id !== labelId);
    return nextLabels.length === labels.length ? null : nextLabels;
  });
}

export async function deleteLabelFromLocalNotes(
  db: SQLiteDatabase,
  labelId: string,
): Promise<void> {
  const rows = await db.getAllAsync<Pick<NoteRow, 'id' | 'labels_json'>>(
    'SELECT id, labels_json FROM notes',
  );

  await db.withTransactionAsync(async () => {
    for (const row of rows) {
      let labels: Label[] = [];
      try {
        labels = JSON.parse(row.labels_json) as Label[];
      } catch {
        continue;
      }

      const nextLabels = labels.filter((label) => label.id !== labelId);
      if (nextLabels.length === labels.length) {
        continue;
      }

      await db.runAsync(
        'UPDATE notes SET labels_json = ?, updated_at = ? WHERE id = ?',
        [JSON.stringify(nextLabels), new Date().toISOString(), row.id],
      );
    }
  });
}

export async function replaceLocalNoteId(
  db: SQLiteDatabase,
  oldId: string,
  newNote: Note,
): Promise<void> {
  // Wrap DELETE + INSERT in a single transaction so a mid-operation crash cannot
  // leave the note permanently deleted without the new server ID being written.
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM notes WHERE id = ?', [oldId]);
    await saveNoteInTx(db, newNote);
  });
}

/**
 * Remove local (server-synced) notes that match the given query scope but are not
 * present in the provided server ID set. Local-only notes (id starting with "local_")
 * are never removed.
 */
export async function getLocalLabels(db: SQLiteDatabase): Promise<Label[]> {
  const rows = await db.getAllAsync<Pick<NoteRow, 'labels_json'>>(
    'SELECT labels_json FROM notes WHERE deleted_at IS NULL',
  );
  const seen = new Set<string>();
  const labels: Label[] = [];
  for (const row of rows) {
    try {
      const noteLabels = JSON.parse(row.labels_json) as Label[];
      for (const label of noteLabels) {
        if (!seen.has(label.id)) {
          seen.add(label.id);
          labels.push(label);
        }
      }
    } catch { /* ignore */ }
  }
  labels.sort((a, b) => a.name.localeCompare(b.name));
  return labels;
}

export async function getLocalLabelCounts(db: SQLiteDatabase): Promise<Record<string, number>> {
  const rows = await db.getAllAsync<Pick<NoteRow, 'labels_json'>>(
    'SELECT labels_json FROM notes WHERE archived = 0 AND deleted_at IS NULL',
  );
  const counts: Record<string, number> = {};
  for (const row of rows) {
    try {
      const labels = JSON.parse(row.labels_json) as Label[];
      const seenIds = new Set<string>();
      for (const label of labels) {
        if (!seenIds.has(label.id)) {
          seenIds.add(label.id);
          counts[label.id] = (counts[label.id] ?? 0) + 1;
        }
      }
    } catch { /* ignore */ }
  }
  return counts;
}

export async function removeLocalNotesNotIn(
  db: SQLiteDatabase,
  serverIds: Set<string>,
  params?: GetNotesParams,
  options?: { skipNoteIds?: ReadonlySet<string> },
): Promise<void> {
  // my_tasks is a cross-cutting filter (overlaps with the main "notes" scope),
  // so we must not remove notes that may still belong in other views.
  if (params?.my_tasks) return;

  // Notes with a pending sync-queue op are protected from pruning too: a queued
  // edit can optimistically move a note into this scope (e.g. un-archive/restore)
  // before the server reflects it, so it would be absent from serverIds and get
  // deleted, destroying the optimistic edit. The drain reconciles them (#487).
  const skipNoteIds = options?.skipNoteIds;

  const scopeArgs: (string | number | null)[] = [];
  let scopedWhereSql = "id NOT LIKE 'local_%'";

  if (params?.archived) {
    scopedWhereSql += ' AND archived = 1 AND deleted_at IS NULL';
  } else if (params?.trashed) {
    scopedWhereSql += ' AND deleted_at IS NOT NULL';
  } else {
    scopedWhereSql += ' AND archived = 0 AND deleted_at IS NULL';
  }

  if (params?.search) {
    scopedWhereSql += ' AND (title LIKE ? OR content LIKE ?)';
    scopeArgs.push(`%${params.search}%`, `%${params.search}%`);
  }

  if (params?.label) {
    // Label-filtered lists are not represented in SQL columns, so scope pruning by
    // parsing labels_json and deleting only notes that matched this label scope.
    const scopedRows = await db.getAllAsync<Pick<NoteRow, 'id' | 'labels_json'>>(
      `SELECT id, labels_json FROM notes WHERE ${scopedWhereSql}`,
      scopeArgs,
    );

    const candidateIds = scopedRows
      .filter((row) => {
        try {
          const labels = JSON.parse(row.labels_json) as Label[];
          return labels.some((label) => label.id === params.label);
        } catch {
          return false;
        }
      })
      .map((row) => row.id)
      .filter((id) => !serverIds.has(id) && !skipNoteIds?.has(id));

    if (candidateIds.length === 0) {
      return;
    }

    const placeholders = candidateIds.map(() => '?').join(', ');
    await db.runAsync(`DELETE FROM notes WHERE id IN (${placeholders})`, candidateIds);
    return;
  }

  let sql = `DELETE FROM notes WHERE ${scopedWhereSql}`;
  const args = [...scopeArgs];

  // Protect both notes still on the server and notes with a pending op:
  // `id NOT IN (A) AND id NOT IN (B)` is just `id NOT IN (A ∪ B)`.
  const protectedIds = new Set([...serverIds, ...(skipNoteIds ?? [])]);
  if (protectedIds.size > 0) {
    const placeholders = Array.from(protectedIds).map(() => '?').join(', ');
    sql += ` AND id NOT IN (${placeholders})`;
    args.push(...protectedIds);
  }

  await db.runAsync(sql, args);
}

// --- Granular local list-item mutations -----------------------------------
// These mirror the server's per-item endpoints so the local SQLite cache stays
// consistent when items are edited one at a time (online or offline).

async function touchLocalNote(db: SQLiteDatabase, noteId: string): Promise<void> {
  await db.runAsync('UPDATE notes SET updated_at = ? WHERE id = ?', [new Date().toISOString(), noteId]);
}

export interface LocalItemInput {
  id: string;
  text: string;
  completed: boolean;
  position: number;
  parent_id: string | null;
  assigned_to: string;
}

export async function createLocalItem(db: SQLiteDatabase, noteId: string, item: LocalItemInput): Promise<void> {
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT OR REPLACE INTO note_items (id, note_id, text, completed, position, parent_id, assigned_to, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [item.id, noteId, item.text, item.completed ? 1 : 0, item.position, item.parent_id ?? null, item.assigned_to ?? '', now, now],
    );
    await touchLocalNote(db, noteId);
  });
}

export interface LocalItemPatch {
  text?: string;
  completed?: boolean;
  position?: number;
  parent_id?: string | null;
  assigned_to?: string;
}

export async function patchLocalItem(db: SQLiteDatabase, noteId: string, itemId: string, patch: LocalItemPatch): Promise<void> {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.text !== undefined) { fields.push('text = ?'); values.push(patch.text); }
  if (patch.completed !== undefined) { fields.push('completed = ?'); values.push(patch.completed ? 1 : 0); }
  if (patch.position !== undefined) { fields.push('position = ?'); values.push(patch.position); }
  if (patch.parent_id !== undefined) { fields.push('parent_id = ?'); values.push(patch.parent_id === '' ? null : patch.parent_id); }
  if (patch.assigned_to !== undefined) { fields.push('assigned_to = ?'); values.push(patch.assigned_to); }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(itemId, noteId);
  await db.withTransactionAsync(async () => {
    await db.runAsync(`UPDATE note_items SET ${fields.join(', ')} WHERE id = ? AND note_id = ?`, values);
    await touchLocalNote(db, noteId);
  });
}

export async function deleteLocalItem(db: SQLiteDatabase, noteId: string, itemId: string): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM note_items WHERE id = ? AND note_id = ?', [itemId, noteId]);
    await touchLocalNote(db, noteId);
  });
}

export async function reorderLocalItems(db: SQLiteDatabase, noteId: string, itemIds: string[]): Promise<void> {
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    for (let i = 0; i < itemIds.length; i++) {
      await db.runAsync('UPDATE note_items SET position = ?, updated_at = ? WHERE id = ? AND note_id = ?', [i, now, itemIds[i], noteId]);
    }
    await touchLocalNote(db, noteId);
  });
}

/** Generate a unique local ID for offline-created notes (prefixed so they are identifiable). */
export function generateLocalId(): string {
  const timestamp = Date.now().toString(36);
  const bytes = new Uint8Array(8);
  getRandomBytes(bytes);
  const random = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `local_${timestamp}_${random}`;
}

// Mirrors the server's ID alphabet/length (see server internal/models/id.go) so a
// client-generated note ID is accepted as-is by the server.
const SERVER_ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SERVER_ID_LENGTH = 22;

/**
 * Generate a server-compatible 22-char note ID. Offline-created notes use this
 * (rather than a `local_*` ID) so the ID is sent as the note's primary key on
 * `POST /notes` and the create replays idempotently — no server-side ID
 * reconciliation is needed because the client ID *is* the server ID (issue #475).
 */
export function generateClientNoteId(): string {
  const bytes = new Uint8Array(SERVER_ID_LENGTH);
  getStrongRandomBytes(bytes);
  let id = '';
  for (let i = 0; i < SERVER_ID_LENGTH; i++) {
    id += SERVER_ID_CHARS[bytes[i] % SERVER_ID_CHARS.length];
  }
  return id;
}

export function isLocalId(id: string): boolean {
  return id.startsWith('local_');
}

/**
 * True for a note not yet known to exist on the server: a local-only duplicate
 * (still carries a `local_*` id pending reconciliation) or an offline create
 * whose queued `POST /notes` hasn't drained yet (#475). Such notes can't be
 * shared or have labels managed until the server knows about them.
 */
export function isUnsyncedNoteId(id: string, pendingNoteIds: ReadonlySet<string>): boolean {
  return isLocalId(id) || pendingNoteIds.has(id);
}
