-- Note shares table - tracks which users have access to which notes
CREATE TABLE note_shares (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    shared_with_user_id TEXT NOT NULL,
    shared_by_user_id TEXT NOT NULL,
    permission_level TEXT NOT NULL DEFAULT 'edit', -- 'edit' is the only permission level for now
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (note_id) REFERENCES notes (id) ON DELETE CASCADE,
    FOREIGN KEY (shared_with_user_id) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (shared_by_user_id) REFERENCES users (id) ON DELETE CASCADE,
    UNIQUE(note_id, shared_with_user_id) -- Prevent duplicate shares
);

-- Indexes for better performance
CREATE INDEX idx_note_shares_note_id ON note_shares(note_id);
CREATE INDEX idx_note_shares_shared_with_user_id ON note_shares(shared_with_user_id);
CREATE INDEX idx_note_shares_shared_by_user_id ON note_shares(shared_by_user_id);
