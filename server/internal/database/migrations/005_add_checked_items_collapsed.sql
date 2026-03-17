-- Add checked_items_collapsed field to notes table
ALTER TABLE notes ADD COLUMN checked_items_collapsed BOOLEAN DEFAULT FALSE;
