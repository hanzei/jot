CREATE TABLE note_user_state (
    note_id    TEXT    NOT NULL REFERENCES notes(id)  ON DELETE CASCADE,
    user_id    TEXT    NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    color      TEXT    NOT NULL DEFAULT '#ffffff',
    pinned     BOOLEAN NOT NULL DEFAULT FALSE,
    archived   BOOLEAN NOT NULL DEFAULT FALSE,
    position   INTEGER NOT NULL DEFAULT 0,
    unpinned_position INTEGER,
    checked_items_collapsed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (note_id, user_id)
);

-- Covering index for per-user note list queries
CREATE INDEX idx_note_user_state_user
    ON note_user_state(user_id, archived, pinned, position);

-- Populate owner rows from existing notes
INSERT INTO note_user_state
    (note_id, user_id, color, pinned, archived, position,
     unpinned_position, checked_items_collapsed, created_at, updated_at)
SELECT id, user_id, color, pinned, archived, position,
       unpinned_position, checked_items_collapsed, created_at, updated_at
FROM notes;

-- Populate collaborator rows from existing shares (use defaults)
INSERT OR IGNORE INTO note_user_state
    (note_id, user_id, created_at, updated_at)
SELECT note_id, shared_with_user_id, created_at, created_at
FROM note_shares;

-- Recreate note_labels with per-user tracking. The old UNIQUE(note_id, label_id)
-- constraint must become UNIQUE(note_id, label_id, user_id) so two collaborators
-- can independently apply the same label to a shared note. SQLite cannot drop
-- constraints, so we recreate the table.
CREATE TABLE note_labels_new (
    id         TEXT     NOT NULL PRIMARY KEY,
    note_id    TEXT     NOT NULL REFERENCES notes(id)  ON DELETE CASCADE,
    label_id   TEXT     NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    user_id    TEXT     NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(note_id, label_id, user_id)
);

-- Only migrate rows whose note still exists; orphaned note_labels are dropped.
INSERT INTO note_labels_new (id, note_id, label_id, user_id, created_at)
SELECT nl.id, nl.note_id, nl.label_id, n.user_id, nl.created_at
FROM note_labels nl
INNER JOIN notes n ON n.id = nl.note_id;

DROP TABLE note_labels;
ALTER TABLE note_labels_new RENAME TO note_labels;
