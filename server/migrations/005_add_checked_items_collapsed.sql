-- Add checked_items_collapsed column to notes table
-- This tracks whether the "Checked items" section is collapsed per note
ALTER TABLE notes ADD COLUMN checked_items_collapsed BOOLEAN DEFAULT TRUE;

-- Also add original_position to note_items to track position before checking
-- This will allow restoring items to their original position when unchecked
ALTER TABLE note_items ADD COLUMN original_position INTEGER;