-- Add unpinned_position field to store the original position when unpinning notes
ALTER TABLE notes ADD COLUMN unpinned_position INTEGER DEFAULT NULL;

-- Initialize unpinned_position for all current notes
-- For unpinned notes, set unpinned_position to current position
-- For pinned notes, set unpinned_position to NULL (they don't need it yet)
UPDATE notes SET unpinned_position = CASE 
    WHEN pinned = FALSE THEN position
    ELSE NULL
END;