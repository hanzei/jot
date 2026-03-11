ALTER TABLE notes ADD COLUMN deleted_at DATETIME DEFAULT NULL;
CREATE INDEX idx_notes_deleted_at ON notes(user_id, deleted_at);
