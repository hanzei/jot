-- Add an explicit parent_id to note_items so a to-do "group" (a top-level item
-- plus its indented children) is a stored relationship instead of one inferred
-- from indent_level. parent_id NULL means the item is top-level.
--
-- ON DELETE SET NULL implements the "orphan" rule: deleting a parent promotes
-- its children to top-level items rather than deleting them.
ALTER TABLE note_items
    ADD COLUMN parent_id TEXT DEFAULT NULL REFERENCES note_items(id) ON DELETE SET NULL;

CREATE INDEX idx_note_items_parent_id ON note_items(parent_id);

-- Backfill parent_id from the legacy indent_level column: every indented
-- (indent_level = 1) item is attached to the nearest preceding top-level
-- (indent_level = 0) item within the same note, by position. An indented item
-- with no preceding top-level item stays NULL (treated as top-level).
UPDATE note_items
SET parent_id = (
    SELECT p.id
    FROM note_items p
    WHERE p.note_id = note_items.note_id
      AND p.indent_level = 0
      AND p.position < note_items.position
    ORDER BY p.position DESC
    LIMIT 1
)
WHERE indent_level = 1;

-- indent_level is now fully derivable from parent_id (parent_id IS NULL ? 0 : 1,
-- since nesting is capped at one level), so drop the redundant column.
ALTER TABLE note_items DROP COLUMN indent_level;
