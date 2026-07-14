import { SQLiteDatabase } from 'expo-sqlite';
import { migrateDatabase, MIGRATIONS } from '../src/db/schema';

type MockDb = {
  execAsync: jest.Mock;
  runAsync: jest.Mock;
  getFirstAsync: jest.Mock;
  getAllAsync: jest.Mock;
};

function makeDb(overrides: Partial<MockDb> = {}): MockDb {
  return {
    execAsync: jest.fn().mockResolvedValue(undefined),
    runAsync: jest.fn().mockResolvedValue({}),
    getFirstAsync: jest.fn().mockResolvedValue({ user_version: 0 }),
    getAllAsync: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

const runSqls = (db: MockDb): string[] =>
  (db.runAsync.mock.calls as unknown[][]).map((c) => c[0] as string);

const ALL_NOTES_COLS = [
  'id', 'user_id', 'title', 'content', 'note_type', 'color', 'pinned', 'archived',
  'position', 'checked_items_collapsed', 'version', 'is_shared', 'deleted_at', 'created_at',
  'updated_at', 'labels_json', 'shared_with_json', 'images_json', 'sync_state',
].map((name) => ({ name }));

const ALL_NOTE_ITEM_COLS = [
  'id', 'note_id', 'text', 'completed', 'position', 'parent_id',
  'assigned_to', 'created_at', 'updated_at',
].map((name) => ({ name }));

// Fully-migrated column sets probed by migration6 (issue #714), in the order it
// probes them: sync_queue.attempts, pending_image_uploads.attempts,
// dead_letter.attempts, dead_letter.error_message.
const SYNC_QUEUE_COLS_FULL = [
  'id', 'operation', 'endpoint', 'method', 'body', 'created_at', 'attempts',
].map((name) => ({ name }));
const IMAGE_UPLOAD_COLS_FULL = [
  'id', 'note_id', 'local_path', 'filename', 'mime_type', 'size_bytes',
  'status', 'error_message', 'created_at', 'attempts',
].map((name) => ({ name }));
const DEAD_LETTER_COLS_FULL = [
  'id', 'operation', 'endpoint', 'method', 'body', 'status', 'note_id',
  'created_at', 'failed_at', 'attempts', 'error_message',
].map((name) => ({ name }));

// migration6 (issue #714) probes four more table_info results after migration5:
// sync_queue.attempts, pending_image_uploads.attempts, dead_letter.attempts, and
// dead_letter.error_message. Existing sequential mocks end at migration5, so each
// chain appends these full column sets (an exhausted mockResolvedValueOnce returns
// undefined → `.some` throws, and full sets mean no spurious ALTER).

describe('migrateDatabase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('fresh install (user_version = 0)', () => {
    it('creates all tables and sets user_version to latest without ALTER TABLE', async () => {
      // On a real fresh install, PRAGMA table_info returns all columns immediately after
      // CREATE TABLE IF NOT EXISTS. The column-probe guards must not attempt ALTER TABLE
      // (which would fail with "duplicate column name" on a real SQLite database).
      const db = makeDb({
        getAllAsync: jest.fn()
          .mockResolvedValueOnce(ALL_NOTES_COLS)
          .mockResolvedValueOnce(ALL_NOTE_ITEM_COLS)
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration2 version probe
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration3 images_json probe
          .mockResolvedValueOnce([]) // migration5 labels backfill: no notes
          .mockResolvedValueOnce(SYNC_QUEUE_COLS_FULL)
          .mockResolvedValueOnce(IMAGE_UPLOAD_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL), // migration6 probes (issue #714)
      });
      await migrateDatabase(db as unknown as SQLiteDatabase);

      expect(db.runAsync).toHaveBeenCalledWith('PRAGMA journal_mode = WAL');
      expect(db.runAsync).toHaveBeenCalledWith('PRAGMA foreign_keys = ON');
      expect(db.execAsync).toHaveBeenCalled();

      const ddl = db.execAsync.mock.calls[0][0] as string;
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS notes');
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS note_items');
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS sync_queue');
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS dead_letter');
      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS users');

      // migration4 (issue #618): offline image upload queue.
      const migration4Ddl = db.execAsync.mock.calls[1][0] as string;
      expect(migration4Ddl).toContain('CREATE TABLE IF NOT EXISTS pending_image_uploads');

      // migration5 (issue #691): canonical local label store.
      const migration5Ddl = db.execAsync.mock.calls[2][0] as string;
      expect(migration5Ddl).toContain('CREATE TABLE IF NOT EXISTS labels');

      expect(runSqls(db).some((s) => s.startsWith('ALTER TABLE'))).toBe(false);
      expect(db.runAsync).toHaveBeenCalledWith(`PRAGMA user_version = ${MIGRATIONS.length}`);
    });
  });

  describe('legacy upgrade (user_version = 0, full schema already present)', () => {
    it('runs migration but skips ALTER TABLE when all columns exist', async () => {
      const db = makeDb({
        getAllAsync: jest.fn()
          .mockResolvedValueOnce(ALL_NOTES_COLS)
          .mockResolvedValueOnce(ALL_NOTE_ITEM_COLS)
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration2 version probe
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration3 images_json probe
          .mockResolvedValueOnce([]) // migration5 labels backfill: no notes
          .mockResolvedValueOnce(SYNC_QUEUE_COLS_FULL)
          .mockResolvedValueOnce(IMAGE_UPLOAD_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL), // migration6 probes (issue #714)
      });
      await migrateDatabase(db as unknown as SQLiteDatabase);

      expect(runSqls(db).some((c) => c.startsWith('ALTER TABLE'))).toBe(false);
      expect(db.runAsync).toHaveBeenCalledWith(`PRAGMA user_version = ${MIGRATIONS.length}`);
    });

    it('adds sync_state column when it is missing', async () => {
      const notesColsWithoutSyncState = ALL_NOTES_COLS.filter((c) => c.name !== 'sync_state');
      const db = makeDb({
        getAllAsync: jest.fn()
          .mockResolvedValueOnce(notesColsWithoutSyncState)
          .mockResolvedValueOnce(ALL_NOTE_ITEM_COLS)
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration2 version probe
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration3 images_json probe
          .mockResolvedValueOnce([]) // migration5 labels backfill: no notes
          .mockResolvedValueOnce(SYNC_QUEUE_COLS_FULL)
          .mockResolvedValueOnce(IMAGE_UPLOAD_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL), // migration6 probes (issue #714)
      });
      await migrateDatabase(db as unknown as SQLiteDatabase);

      expect(db.runAsync).toHaveBeenCalledWith(
        `ALTER TABLE notes ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'synced'`,
      );
    });

    it('adds the version column when it is missing (issue #489)', async () => {
      const notesColsWithoutVersion = ALL_NOTES_COLS.filter((c) => c.name !== 'version');
      const db = makeDb({
        getAllAsync: jest.fn()
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration1 sync_state probe
          .mockResolvedValueOnce(ALL_NOTE_ITEM_COLS)
          .mockResolvedValueOnce(notesColsWithoutVersion) // migration2 version probe
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration3 images_json probe
          .mockResolvedValueOnce([]) // migration5 labels backfill: no notes
          .mockResolvedValueOnce(SYNC_QUEUE_COLS_FULL)
          .mockResolvedValueOnce(IMAGE_UPLOAD_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL), // migration6 probes (issue #714)
      });
      await migrateDatabase(db as unknown as SQLiteDatabase);

      expect(db.runAsync).toHaveBeenCalledWith(
        `ALTER TABLE notes ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
      );
    });

    it('adds missing note_items columns', async () => {
      const noteItemColsWithoutNew = ALL_NOTE_ITEM_COLS.filter(
        (c) => !['created_at', 'updated_at', 'assigned_to'].includes(c.name),
      );
      const db = makeDb({
        getAllAsync: jest.fn()
          .mockResolvedValueOnce(ALL_NOTES_COLS)
          .mockResolvedValueOnce(noteItemColsWithoutNew)
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration2 version probe
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration3 images_json probe
          .mockResolvedValueOnce([]) // migration5 labels backfill: no notes
          .mockResolvedValueOnce(SYNC_QUEUE_COLS_FULL)
          .mockResolvedValueOnce(IMAGE_UPLOAD_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL), // migration6 probes (issue #714)
      });
      await migrateDatabase(db as unknown as SQLiteDatabase);

      for (const col of ['created_at', 'updated_at', 'assigned_to']) {
        expect(db.runAsync).toHaveBeenCalledWith(
          `ALTER TABLE note_items ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`,
        );
      }
    });

    it('adds the images_json column when it is missing (issue #616)', async () => {
      const notesColsWithoutImages = ALL_NOTES_COLS.filter((c) => c.name !== 'images_json');
      const db = makeDb({
        getAllAsync: jest.fn()
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration1 sync_state probe
          .mockResolvedValueOnce(ALL_NOTE_ITEM_COLS)
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration2 version probe
          .mockResolvedValueOnce(notesColsWithoutImages) // migration3 images_json probe
          .mockResolvedValueOnce([]) // migration5 labels backfill: no notes
          .mockResolvedValueOnce(SYNC_QUEUE_COLS_FULL)
          .mockResolvedValueOnce(IMAGE_UPLOAD_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL), // migration6 probes (issue #714)
      });
      await migrateDatabase(db as unknown as SQLiteDatabase);

      expect(db.runAsync).toHaveBeenCalledWith(
        `ALTER TABLE notes ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]'`,
      );
    });

    it('adds the attempts/error_message columns when they are missing (issue #714)', async () => {
      const db = makeDb({
        getAllAsync: jest.fn()
          .mockResolvedValueOnce(ALL_NOTES_COLS)
          .mockResolvedValueOnce(ALL_NOTE_ITEM_COLS)
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration2 version probe
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration3 images_json probe
          .mockResolvedValueOnce([]) // migration5 labels backfill: no notes
          // migration6 probes: every target column is still missing.
          .mockResolvedValueOnce(SYNC_QUEUE_COLS_FULL.filter((c) => c.name !== 'attempts'))
          .mockResolvedValueOnce(IMAGE_UPLOAD_COLS_FULL.filter((c) => c.name !== 'attempts'))
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL.filter((c) => c.name !== 'attempts' && c.name !== 'error_message'))
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL.filter((c) => c.name !== 'attempts' && c.name !== 'error_message')),
      });
      await migrateDatabase(db as unknown as SQLiteDatabase);

      expect(db.runAsync).toHaveBeenCalledWith('ALTER TABLE sync_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
      expect(db.runAsync).toHaveBeenCalledWith('ALTER TABLE pending_image_uploads ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
      expect(db.runAsync).toHaveBeenCalledWith('ALTER TABLE dead_letter ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
      expect(db.runAsync).toHaveBeenCalledWith('ALTER TABLE dead_letter ADD COLUMN error_message TEXT');
    });

    it('skips the migration6 ALTERs when the columns already exist (issue #714)', async () => {
      const db = makeDb({
        getAllAsync: jest.fn()
          .mockResolvedValueOnce(ALL_NOTES_COLS)
          .mockResolvedValueOnce(ALL_NOTE_ITEM_COLS)
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration2 version probe
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration3 images_json probe
          .mockResolvedValueOnce([]) // migration5 labels backfill: no notes
          .mockResolvedValueOnce(SYNC_QUEUE_COLS_FULL)
          .mockResolvedValueOnce(IMAGE_UPLOAD_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL),
      });
      await migrateDatabase(db as unknown as SQLiteDatabase);

      expect(runSqls(db).some((s) => s.includes('ADD COLUMN attempts'))).toBe(false);
      expect(runSqls(db).some((s) => s.includes('ADD COLUMN error_message'))).toBe(false);
    });
  });

  describe('already at latest version', () => {
    it('skips all migration steps', async () => {
      const db = makeDb({
        getFirstAsync: jest.fn().mockResolvedValue({ user_version: MIGRATIONS.length }),
      });
      await migrateDatabase(db as unknown as SQLiteDatabase);

      expect(db.execAsync).not.toHaveBeenCalled();
      expect(runSqls(db)).toEqual(['PRAGMA journal_mode = WAL', 'PRAGMA foreign_keys = ON']);
    });
  });

  describe('indent_level → parent_id backfill', () => {
    it('derives parent_id from indent_level for pre-parent_id installs', async () => {
      const noteItemColsWithIndent = ALL_NOTE_ITEM_COLS.filter((c) => c.name !== 'parent_id')
        .concat([{ name: 'indent_level' }]);

      const rows = [
        { id: 'item1', note_id: 'note1', indent_level: 0 },
        { id: 'item2', note_id: 'note1', indent_level: 1 },
        { id: 'item3', note_id: 'note1', indent_level: 0 },
        { id: 'item4', note_id: 'note1', indent_level: 1 },
      ];

      const db = makeDb({
        getAllAsync: jest.fn()
          .mockResolvedValueOnce(ALL_NOTES_COLS)
          .mockResolvedValueOnce(noteItemColsWithIndent)
          .mockResolvedValueOnce(rows)
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration2 version probe
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration3 images_json probe
          .mockResolvedValueOnce([]) // migration5 labels backfill: no notes
          .mockResolvedValueOnce(SYNC_QUEUE_COLS_FULL)
          .mockResolvedValueOnce(IMAGE_UPLOAD_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL), // migration6 probes (issue #714)
      });
      await migrateDatabase(db as unknown as SQLiteDatabase);

      expect(db.runAsync).toHaveBeenCalledWith(
        `ALTER TABLE note_items ADD COLUMN parent_id TEXT DEFAULT NULL`,
      );
      expect(db.runAsync).toHaveBeenCalledWith(
        `UPDATE note_items SET parent_id = ? WHERE id = ?`,
        ['item1', 'item2'],
      );
      expect(db.runAsync).toHaveBeenCalledWith(
        `UPDATE note_items SET parent_id = ? WHERE id = ?`,
        ['item3', 'item4'],
      );
    });

    it('does not backfill parent_id when indent_level column is absent', async () => {
      const noteItemColsWithoutBoth = ALL_NOTE_ITEM_COLS.filter((c) => c.name !== 'parent_id');
      const db = makeDb({
        getAllAsync: jest.fn()
          .mockResolvedValueOnce(ALL_NOTES_COLS)
          .mockResolvedValueOnce(noteItemColsWithoutBoth)
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration2 version probe
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration3 images_json probe
          .mockResolvedValueOnce([]) // migration5 labels backfill: no notes
          .mockResolvedValueOnce(SYNC_QUEUE_COLS_FULL)
          .mockResolvedValueOnce(IMAGE_UPLOAD_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL), // migration6 probes (issue #714)
      });
      await migrateDatabase(db as unknown as SQLiteDatabase);

      expect(db.runAsync).toHaveBeenCalledWith(
        `ALTER TABLE note_items ADD COLUMN parent_id TEXT DEFAULT NULL`,
      );
      const updateCalls = (db.runAsync.mock.calls as unknown[][]).filter(
        (c) => c[0] === `UPDATE note_items SET parent_id = ? WHERE id = ?`,
      );
      expect(updateCalls).toHaveLength(0);
    });
  });

  describe('labels store backfill (issue #691)', () => {
    it('backfills the labels table from notes.labels_json, deduping by id', async () => {
      const db = makeDb({
        getAllAsync: jest.fn()
          .mockResolvedValueOnce(ALL_NOTES_COLS)
          .mockResolvedValueOnce(ALL_NOTE_ITEM_COLS)
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration2 version probe
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration3 images_json probe
          .mockResolvedValueOnce([
            { labels_json: JSON.stringify([{ id: 'l1', user_id: 'u1', name: 'Work', created_at: 'c1', updated_at: 'u1t' }]) },
            // A duplicate id across notes is inserted once (seen guard + INSERT OR IGNORE).
            { labels_json: JSON.stringify([{ id: 'l1', user_id: 'u1', name: 'Work', created_at: 'c1', updated_at: 'u1t' }, { id: 'l2', user_id: 'u1', name: 'Home', created_at: 'c2', updated_at: 'u2t' }]) },
            { labels_json: 'not json' }, // malformed row is tolerated and skipped
            { labels_json: '5' }, // valid JSON but not an array — tolerated and skipped
            { labels_json: '{}' }, // valid JSON object (not an array) — tolerated and skipped
          ])
          .mockResolvedValueOnce(SYNC_QUEUE_COLS_FULL)
          .mockResolvedValueOnce(IMAGE_UPLOAD_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL), // migration6 probes (issue #714)
      });
      await migrateDatabase(db as unknown as SQLiteDatabase);

      const insertCalls = (db.runAsync.mock.calls as unknown[][]).filter(
        (c) => String(c[0]).startsWith('INSERT OR IGNORE INTO labels'),
      );
      expect(insertCalls).toHaveLength(2);
      expect(insertCalls[0][1]).toEqual(['l1', 'u1', 'Work', 'c1', 'u1t']);
      expect(insertCalls[1][1]).toEqual(['l2', 'u1', 'Home', 'c2', 'u2t']);
    });

    it('inserts nothing when there are no notes to backfill from', async () => {
      const db = makeDb({
        getAllAsync: jest.fn()
          .mockResolvedValueOnce(ALL_NOTES_COLS)
          .mockResolvedValueOnce(ALL_NOTE_ITEM_COLS)
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration2 version probe
          .mockResolvedValueOnce(ALL_NOTES_COLS) // migration3 images_json probe
          .mockResolvedValueOnce([]) // migration5 labels backfill: no notes
          .mockResolvedValueOnce(SYNC_QUEUE_COLS_FULL)
          .mockResolvedValueOnce(IMAGE_UPLOAD_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL)
          .mockResolvedValueOnce(DEAD_LETTER_COLS_FULL), // migration6 probes (issue #714)
      });
      await migrateDatabase(db as unknown as SQLiteDatabase);

      const insertCalls = (db.runAsync.mock.calls as unknown[][]).filter(
        (c) => String(c[0]).startsWith('INSERT OR IGNORE INTO labels'),
      );
      expect(insertCalls).toHaveLength(0);
    });
  });
});
