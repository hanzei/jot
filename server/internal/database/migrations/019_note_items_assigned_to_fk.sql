PRAGMA foreign_keys = OFF;

CREATE TABLE note_items_new (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    text TEXT NOT NULL DEFAULT '',
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    position INTEGER NOT NULL DEFAULT 0,
    indent_level INTEGER NOT NULL DEFAULT 0,
    assigned_to TEXT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO note_items_new
    SELECT id, note_id, text, completed, position, indent_level,
           NULLIF(assigned_to, ''),
           created_at, updated_at
    FROM note_items;

DROP TABLE note_items;
ALTER TABLE note_items_new RENAME TO note_items;

-- Recreate indexes that existed on the original table
CREATE INDEX idx_note_items_note_id ON note_items(note_id);
CREATE INDEX idx_note_items_position ON note_items(note_id, position);
CREATE INDEX idx_note_items_assigned_to ON note_items(assigned_to);
CREATE INDEX idx_note_items_note_assigned ON note_items(note_id, assigned_to);

PRAGMA foreign_keys = ON;
