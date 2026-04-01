-- Add CHECK (role IN ('user', 'admin')) to users.role and tighten it to NOT NULL.
-- All existing rows already have valid roles so the INSERT…SELECT is safe.
--
-- Also tighten note_shares timestamp columns to NOT NULL to match every other
-- table added since migration 006.

PRAGMA foreign_keys = OFF;

-- 1a: Recreate users with role CHECK constraint
CREATE TABLE users_new (
    id                        TEXT PRIMARY KEY,
    username                  TEXT NOT NULL,
    password_hash             TEXT NOT NULL,
    role                      TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    first_name                TEXT NOT NULL DEFAULT '',
    last_name                 TEXT NOT NULL DEFAULT '',
    profile_icon              BLOB,
    profile_icon_content_type TEXT,
    created_at                DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at                DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users_new
    SELECT id, username, password_hash, role, first_name, last_name,
           profile_icon, profile_icon_content_type, created_at, updated_at
    FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE UNIQUE INDEX idx_users_username ON users(username);

-- 1b: Recreate note_shares with NOT NULL timestamps
CREATE TABLE note_shares_new (
    id                   TEXT PRIMARY KEY,
    note_id              TEXT NOT NULL REFERENCES notes(id)  ON DELETE CASCADE,
    shared_with_user_id  TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    shared_by_user_id    TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    permission_level     TEXT NOT NULL DEFAULT 'edit',
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(note_id, shared_with_user_id)
);

INSERT INTO note_shares_new
    SELECT id, note_id, shared_with_user_id, shared_by_user_id, permission_level,
           COALESCE(created_at, CURRENT_TIMESTAMP),
           COALESCE(updated_at, CURRENT_TIMESTAMP)
    FROM note_shares;

DROP TABLE note_shares;
ALTER TABLE note_shares_new RENAME TO note_shares;

CREATE INDEX idx_note_shares_note_id             ON note_shares(note_id);
CREATE INDEX idx_note_shares_shared_with_user_id ON note_shares(shared_with_user_id);
CREATE INDEX idx_note_shares_shared_by_user_id   ON note_shares(shared_by_user_id);

PRAGMA foreign_keys = ON;
