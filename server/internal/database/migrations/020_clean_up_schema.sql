-- Drop stale per-user-state columns from notes (color, pinned, archived, position,
-- unpinned_position, checked_items_collapsed). These were moved to note_user_state
-- in migration 019 and are no longer read from notes by any application code.
-- Table recreation is required because the active_notes view and idx_notes_position
-- index reference columns being removed and SQLite cannot drop those first.

DROP VIEW active_notes;

CREATE TABLE notes_new (
    id        TEXT PRIMARY KEY,
    user_id   TEXT NOT NULL,
    title     TEXT NOT NULL DEFAULT '',
    content   TEXT NOT NULL DEFAULT '',
    note_type TEXT NOT NULL DEFAULT 'text',
    deleted_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
-- idx_notes_position (user_id, pinned, position) is intentionally not recreated:
-- pinned and position no longer exist on notes; note_user_state carries those fields
-- and has its own covering index (idx_note_user_state_user).

-- Recreate active_notes view with explicit column list instead of SELECT *.
CREATE VIEW active_notes AS
    SELECT id, user_id, title, content, note_type, deleted_at, created_at, updated_at
    FROM notes
    WHERE deleted_at IS NULL;

-- Restore note_labels indexes that were dropped but not recreated in migration 019,
-- and add the new user_id index needed for per-user label queries.
CREATE INDEX idx_note_labels_note_id  ON note_labels(note_id);
CREATE INDEX idx_note_labels_label_id ON note_labels(label_id);
CREATE INDEX idx_note_labels_user_id  ON note_labels(user_id);

-- Recreate sessions with NOT NULL on created_at for consistency with all other
-- timestamp columns added since migration 006.
CREATE TABLE sessions_new (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

INSERT INTO sessions_new (token, user_id, user_agent, expires_at, created_at)
SELECT token, user_id, user_agent, expires_at, COALESCE(created_at, CURRENT_TIMESTAMP)
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX idx_sessions_user_id    ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
