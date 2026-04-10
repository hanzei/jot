-- Remove the CHECK constraint on note_type that was present on old installations.
-- New installations (using the new 000001) never had this constraint, so this
-- migration is effectively a no-op for them.

DROP VIEW active_notes;

CREATE TABLE notes_new (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL DEFAULT '',
    note_type  TEXT NOT NULL DEFAULT 'text',
    deleted_at DATETIME DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

INSERT INTO notes_new (id, user_id, title, content, note_type, deleted_at, created_at, updated_at)
SELECT id, user_id, title, content, note_type, deleted_at, created_at, updated_at
FROM notes;

DROP TABLE notes;

ALTER TABLE notes_new RENAME TO notes;

CREATE INDEX idx_notes_user_id    ON notes(user_id);
CREATE INDEX idx_notes_updated_at ON notes(updated_at DESC);
CREATE INDEX idx_notes_deleted_at ON notes(user_id, deleted_at);

CREATE VIEW active_notes AS
    SELECT id, user_id, title, content, note_type, deleted_at, created_at, updated_at
    FROM notes
    WHERE deleted_at IS NULL;
