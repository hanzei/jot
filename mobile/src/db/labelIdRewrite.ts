import type { SQLiteDatabase } from 'expo-sqlite';
import type { Label } from '@jot/shared';
import { labelKey } from './queueKeys';

/** Replace every string equal to `from` inside a parsed JSON value. */
function replaceValue(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value === from ? to : value;
  if (Array.isArray(value)) return value.map((item) => replaceValue(item, from, to));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, replaceValue(v, from, to)]),
    );
  }
  return value;
}

/**
 * Persistently re-point a label from the id `from` to `to`: the queued and
 * dead-lettered operations that reference it (endpoint path segment or any body
 * value), the local label store, and the labels attached to local notes.
 *
 * Used when a replayed `createLabel` finds that another label already owns the
 * name, so the client-minted id will never exist on the server. Doing it in the
 * database rather than in memory means an op queued behind a *later* drain also
 * targets the surviving label. Callers run it inside a transaction.
 *
 * The ops' recorded `label:` keys are not touched: {@link rewriteLabelKeys}
 * moves them, so a migration older than the key tables can call this one.
 *
 * `to` is the label that survives, so it replaces `from` everywhere: when a note
 * already carries `to`, the duplicate `from` entry is dropped.
 */
export async function rewriteLabelId(db: SQLiteDatabase, from: string, to: string, target: Label): Promise<void> {
  for (const table of ['sync_queue', 'dead_letter']) {
    const rows = await db.getAllAsync<{ id: number; endpoint: string; body: string | null }>(
      `SELECT id, endpoint, body FROM ${table}`,
    );
    for (const row of rows) {
      const endpoint = row.endpoint.split('/').map((seg) => (seg === from ? to : seg)).join('/');
      let body = row.body;
      if (body !== null && body.includes(from)) {
        try {
          body = JSON.stringify(replaceValue(JSON.parse(body), from, to));
        } catch {
          // Unparseable body: leave it for the drain's own error handling.
        }
      }
      if (endpoint !== row.endpoint || body !== row.body) {
        await db.runAsync(`UPDATE ${table} SET endpoint = ?, body = ? WHERE id = ?`, [endpoint, body, row.id]);
      }
    }
  }

  await db.runAsync('DELETE FROM labels WHERE id = ?', [from]);
  await db.runAsync(
    `INSERT INTO labels (id, user_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       user_id = excluded.user_id,
       name = excluded.name,
       updated_at = excluded.updated_at`,
    [target.id, target.user_id, target.name, target.created_at, target.updated_at],
  );

  const notes = await db.getAllAsync<{ id: string; labels_json: string }>(
    'SELECT id, labels_json FROM notes WHERE labels_json LIKE ?',
    [`%${from}%`],
  );
  for (const note of notes) {
    let labels: Label[];
    try {
      labels = JSON.parse(note.labels_json) as Label[];
    } catch {
      continue;
    }
    const next: Label[] = [];
    for (const label of labels) {
      const mapped = label.id === from ? target : label;
      if (!next.some((l) => l.id === mapped.id)) next.push(mapped);
    }
    await db.runAsync('UPDATE notes SET labels_json = ? WHERE id = ?', [JSON.stringify(next), note.id]);
  }
}

/**
 * Re-point the queued and dead-lettered ops' recorded `label:` keys from `from`
 * to `to`, alongside {@link rewriteLabelId}. Callers run it inside a transaction.
 */
export async function rewriteLabelKeys(db: SQLiteDatabase, from: string, to: string): Promise<void> {
  for (const table of ['sync_queue_keys', 'dead_letter_keys']) {
    // A row already keyed by `to` keeps that key; its `from` key just goes.
    await db.runAsync(`UPDATE OR IGNORE ${table} SET key = ? WHERE key = ?`, [labelKey(to), labelKey(from)]);
    await db.runAsync(`DELETE FROM ${table} WHERE key = ?`, [labelKey(from)]);
  }
}
