ALTER TABLE user_settings ADD COLUMN note_sort TEXT NOT NULL DEFAULT 'manual' CHECK (note_sort IN ('manual', 'updated_at', 'created_at'));
