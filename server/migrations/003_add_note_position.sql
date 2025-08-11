-- Add position field to notes table for custom ordering
ALTER TABLE notes ADD COLUMN position INTEGER DEFAULT 0;

-- Create index for position ordering
CREATE INDEX idx_notes_position ON notes(user_id, pinned, position);

-- Initialize positions for existing notes based on current ordering
-- Pinned notes get positions 0, 1, 2, etc.
-- Unpinned notes get positions 0, 1, 2, etc. (separate sequence)
UPDATE notes SET position = (
    SELECT ROW_NUMBER() OVER (
        PARTITION BY user_id, pinned 
        ORDER BY updated_at DESC
    ) - 1
);
