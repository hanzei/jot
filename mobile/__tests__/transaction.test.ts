/**
 * Tests for `withSerializedTransaction` (src/db/transaction.ts) — the wrapper
 * every multi-statement write goes through.
 *
 * These only mean anything against a real SQLite engine (see
 * `helpers/testDb.ts`): with a pass-through `withTransactionAsync` stub, a
 * transaction that throws part-way leaves its partial writes in place and the
 * test still passes.
 */

import { withSerializedTransaction } from '../src/db/transaction';
import { saveNotes } from '../src/db/noteQueries';
import { makeTextNote } from './helpers/fixtures';
import { createMigratedTestDb, type TestDatabase } from './helpers/testDb';

let db: TestDatabase;

beforeEach(() => {
  db = globalThis.testDb;
});

const noteIds = async (): Promise<string[]> => {
  const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM notes ORDER BY id');
  return rows.map((r) => r.id);
};

const insertNote = (id: string) =>
  db.runAsync(
    `INSERT INTO notes (id, user_id, created_at, updated_at) VALUES (?, 'u1', '', '')`,
    [id],
  );

describe('withSerializedTransaction', () => {
  it('commits every write in the task', async () => {
    await withSerializedTransaction(db, async () => {
      await insertNote('a');
      await insertNote('b');
    });

    expect(await noteIds()).toEqual(['a', 'b']);
  });

  it('rolls back writes already made when the task throws part-way', async () => {
    await expect(
      withSerializedTransaction(db, async () => {
        await insertNote('committed-before-throw');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await noteIds()).toEqual([]);
  });

  it('rolls back on a constraint violation raised by the database itself', async () => {
    await insertNote('existing');

    await expect(
      withSerializedTransaction(db, async () => {
        await insertNote('new');
        await insertNote('existing'); // duplicate primary key
      }),
    ).rejects.toThrow(/UNIQUE constraint/i);

    // The successful first insert goes back with the failed one.
    expect(await noteIds()).toEqual(['existing']);
  });

  it('leaves earlier committed transactions intact when a later one fails', async () => {
    await withSerializedTransaction(db, async () => { await insertNote('kept'); });

    await expect(
      withSerializedTransaction(db, async () => {
        await insertNote('discarded');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await noteIds()).toEqual(['kept']);
  });

  it('does not wedge the write chain after a failed transaction', async () => {
    const failed = withSerializedTransaction(db, async () => {
      await insertNote('discarded');
      throw new Error('boom');
    });
    // Queued behind the failure, without awaiting it first: the rejection is
    // swallowed on the shared chain precisely so this still runs.
    const next = withSerializedTransaction(db, async () => { await insertNote('after'); });

    await expect(failed).rejects.toThrow('boom');
    await next;

    expect(await noteIds()).toEqual(['after']);
  });

  it('serializes concurrent transactions rather than nesting them', async () => {
    // SQLite allows only one active transaction per connection, so overlapping
    // callers must queue — starting a second BEGIN inside the first would throw
    // "cannot start a transaction within a transaction".
    const order: string[] = [];
    const first = withSerializedTransaction(db, async () => {
      order.push('first:start');
      await insertNote('first');
      order.push('first:end');
    });
    const second = withSerializedTransaction(db, async () => {
      order.push('second:start');
      await insertNote('second');
      order.push('second:end');
    });

    await Promise.all([first, second]);

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(await noteIds()).toEqual(['first', 'second']);
  });

  it('keeps each database connection on its own chain', async () => {
    // The chain is keyed per connection (a WeakMap on the db object), so a
    // failure on one database must not roll back or block another's writes.
    const other = await createMigratedTestDb();

    await expect(
      withSerializedTransaction(db, async () => {
        await insertNote('discarded');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await withSerializedTransaction(other, async () => {
      await other.runAsync(`INSERT INTO notes (id, user_id, created_at, updated_at) VALUES ('kept', 'u1', '', '')`);
    });

    expect(await noteIds()).toEqual([]);
    expect(await other.getAllAsync('SELECT id FROM notes')).toEqual([{ id: 'kept' }]);
  });
});

describe('batch writes roll back as a unit', () => {
  it('discards the whole saveNotes batch when one note is rejected by the schema', async () => {
    // user_id is NOT NULL with no default, so a malformed note in the middle of
    // the batch aborts it — the notes written before it must not survive.
    const bad = { ...makeTextNote({ id: 'bad' }), user_id: null } as never;

    await expect(saveNotes(db, [makeTextNote({ id: 'first' }), bad, makeTextNote({ id: 'last' })])).rejects.toThrow(
      /NOT NULL constraint/i,
    );

    expect(await noteIds()).toEqual([]);
  });

  it('substitutes the column default when a NOT NULL column that has one is written NULL', async () => {
    // saveNote writes with INSERT OR REPLACE, and SQLite's REPLACE conflict
    // resolution fills a NOT NULL violation with the column's DEFAULT instead of
    // aborting. So a null note_type lands as 'text' rather than raising — worth
    // pinning, because it is the difference between a silent coercion and an error.
    await saveNotes(db, [{ ...makeTextNote({ id: 'coerced' }), note_type: null } as never]);

    expect(await db.getFirstAsync('SELECT note_type FROM notes WHERE id = ?', ['coerced'])).toEqual({
      note_type: 'text',
    });
  });
});
