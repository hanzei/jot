PRAGMA foreign_keys=OFF;

ALTER TABLE note_items RENAME TO note_items_old;

CREATE TABLE note_items (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    text TEXT NOT NULL,
    completed BOOLEAN DEFAULT FALSE,
    position INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    indent_level INTEGER NOT NULL DEFAULT 0,
    assigned_to TEXT,
    FOREIGN KEY (note_id) REFERENCES notes (id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_to) REFERENCES users (id) ON DELETE SET NULL
);

INSERT INTO note_items (
    id, note_id, text, completed, position, created_at, updated_at, indent_level, assigned_to
)
SELECT
    ni.id,
    ni.note_id,
    ni.text,
    ni.completed,
    ni.position,
    ni.created_at,
    ni.updated_at,
    ni.indent_level,
    CASE
        WHEN ni.assigned_to = '' THEN NULL
        WHEN u.id IS NULL THEN NULL
        ELSE ni.assigned_to
    END AS assigned_to
FROM note_items_old ni
LEFT JOIN users u ON u.id = ni.assigned_to;

DROP TABLE note_items_old;

CREATE INDEX idx_note_items_assigned_to ON note_items(assigned_to);
CREATE INDEX idx_note_items_note_assigned ON note_items(note_id, assigned_to);
CREATE INDEX idx_note_items_note_id ON note_items(note_id);
CREATE INDEX idx_note_items_position ON note_items(note_id, position);

PRAGMA foreign_keys=ON;
