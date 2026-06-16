-- Add an integer optimistic-concurrency version to notes (issue #489). It is
-- bumped whenever a note's shared content (title/content) changes, so a client
-- can send the version its edit was based on (base_version) and the server can
-- reject a stale write — a concurrent edit made on another device — with 409
-- instead of silently overwriting the newer change.
ALTER TABLE notes ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- active_notes lists its columns explicitly, so recreate it to expose version.
DROP VIEW active_notes;
CREATE VIEW active_notes AS
    SELECT id, user_id, title, content, note_type, version, deleted_at, created_at, updated_at
    FROM notes
    WHERE deleted_at IS NULL;
