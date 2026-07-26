-- Drop permission_level from note_shares: the column's CHECK constraint only
-- ever allowed 'edit', so it was a single-value field masquerading as an open
-- string in every client-facing type. Dropping it now (pre-v1) keeps the
-- field additive when read-only / multi-level sharing is actually built.
--
-- SQLite's ALTER TABLE DROP COLUMN refuses to drop a column referenced by a
-- CHECK constraint, so this rebuilds the table without it (standard SQLite
-- pattern), preserving all existing rows, indexes, and foreign keys.
CREATE TABLE note_shares_new (
    id                  TEXT     PRIMARY KEY,
    note_id             TEXT     NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    shared_with_user_id TEXT     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shared_by_user_id   TEXT     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(note_id, shared_with_user_id)
);

INSERT INTO note_shares_new (id, note_id, shared_with_user_id, shared_by_user_id, created_at, updated_at)
SELECT id, note_id, shared_with_user_id, shared_by_user_id, created_at, updated_at
FROM note_shares;

DROP TABLE note_shares;

ALTER TABLE note_shares_new RENAME TO note_shares;

CREATE INDEX idx_note_shares_note_id             ON note_shares(note_id);
CREATE INDEX idx_note_shares_shared_with_user_id ON note_shares(shared_with_user_id);
CREATE INDEX idx_note_shares_shared_by_user_id   ON note_shares(shared_by_user_id);
