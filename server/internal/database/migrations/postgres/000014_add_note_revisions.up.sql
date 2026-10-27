-- Note version history (#1129).
--
-- A revision is a snapshot of a note's shared content (type, title, content,
-- items) as it was just before a write replaced it. Writes coalesce: a new
-- snapshot is stored only when the note's latest revision is older than the
-- coalescing window or was recorded for a different writer, so continuous
-- autosaves and one-at-a-time item writes do not each leave a revision.
--
-- edited_at / actor_id describe the snapshotted content: when it was last
-- edited and by whom (copied from notes.content_changed_at/_by, so actor_id is
-- not a foreign key, for the same reason content_changed_by is not).
-- replaced_by / replaced_by_client name the write that replaced it, and are
-- what the coalescing check compares against. replaced_by_client is the
-- writing client's X-Client-Id ('mcp' for MCP tools, '' when none was sent).
--
-- Images are deliberately not part of a revision: a revision referencing an
-- image would make blob reclamation scan revisions too.
--
-- Deleting a note removes its history through the cascade; a periodic task
-- prunes revisions beyond the per-note count and age caps.
CREATE TABLE note_revisions (
    id                 TEXT      PRIMARY KEY,
    note_id            TEXT      NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    edited_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actor_id           TEXT,
    note_type          TEXT      NOT NULL,
    title              TEXT      NOT NULL DEFAULT '',
    content            TEXT      NOT NULL DEFAULT '',
    items_json         TEXT      NOT NULL DEFAULT '[]',
    replaced_by        TEXT      NOT NULL,
    replaced_by_client TEXT      NOT NULL DEFAULT ''
);

CREATE INDEX idx_note_revisions_note_id    ON note_revisions(note_id, created_at, id);
CREATE INDEX idx_note_revisions_created_at ON note_revisions(created_at);
