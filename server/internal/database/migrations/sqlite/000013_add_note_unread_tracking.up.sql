-- Unread tracking for the "New" / "Updated" note badges.
--
-- note_user_state.last_viewed_at is when that user last opened the note (or
-- edited its shared content, which counts as viewing it). NULL on a
-- collaborator's row means they have never opened a note shared with them.
--
-- notes.content_changed_at / content_changed_by record the latest change to
-- shared content (title, content, items, type) and who made it. They are
-- deliberately separate from updated_at, which also moves on trash/restore and
-- does not say who acted. content_changed_by is not a foreign key: a deleted
-- user simply stops matching anyone, which is what the badge rule needs.
ALTER TABLE note_user_state ADD COLUMN last_viewed_at DATETIME;
ALTER TABLE notes ADD COLUMN content_changed_at DATETIME;
ALTER TABLE notes ADD COLUMN content_changed_by TEXT;

-- Existing installations start with nothing unread: every current row counts
-- as viewed, and pre-existing content has no recorded change.
UPDATE note_user_state SET last_viewed_at = created_at;

-- active_notes lists its columns explicitly, so recreate it to expose the new ones.
DROP VIEW active_notes;
CREATE VIEW active_notes AS
    SELECT id, user_id, title, content, note_type, version, deleted_at, created_at, updated_at,
           content_changed_at, content_changed_by
    FROM notes
    WHERE deleted_at IS NULL;
