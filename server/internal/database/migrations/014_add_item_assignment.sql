ALTER TABLE note_items ADD COLUMN assigned_to TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_note_items_assigned_to ON note_items(assigned_to);
CREATE INDEX idx_note_items_note_assigned ON note_items(note_id, assigned_to);
