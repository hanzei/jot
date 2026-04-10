-- Users table
CREATE TABLE users (
    id                        TEXT PRIMARY KEY,
    username                  TEXT NOT NULL,
    password_hash             TEXT NOT NULL,
    role                      TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    first_name                TEXT NOT NULL DEFAULT '',
    last_name                 TEXT NOT NULL DEFAULT '',
    profile_icon              BYTEA,
    profile_icon_content_type TEXT,
    created_at                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_users_username ON users(username);

-- Notes table
CREATE TABLE notes (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL DEFAULT '',
    note_type  TEXT NOT NULL DEFAULT 'text' CHECK (note_type IN ('text', 'list')),
    deleted_at TIMESTAMP DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX idx_notes_user_id    ON notes(user_id);
CREATE INDEX idx_notes_updated_at ON notes(updated_at DESC);
CREATE INDEX idx_notes_deleted_at ON notes(user_id, deleted_at);

-- Note items table
CREATE TABLE note_items (
    id           TEXT     PRIMARY KEY,
    note_id      TEXT     NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    text         TEXT     NOT NULL DEFAULT '',
    completed    BOOLEAN  NOT NULL DEFAULT FALSE,
    position     INTEGER  NOT NULL DEFAULT 0,
    indent_level INTEGER  NOT NULL DEFAULT 0,
    assigned_to  TEXT     DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_note_items_position      ON note_items(note_id, position);
CREATE INDEX idx_note_items_assigned_to   ON note_items(assigned_to);
CREATE INDEX idx_note_items_note_assigned ON note_items(note_id, assigned_to);

-- Note shares table
CREATE TABLE note_shares (
    id                  TEXT     PRIMARY KEY,
    note_id             TEXT     NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    shared_with_user_id TEXT     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shared_by_user_id   TEXT     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission_level    TEXT     NOT NULL DEFAULT 'edit' CHECK (permission_level IN ('edit')),
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(note_id, shared_with_user_id)
);

CREATE INDEX idx_note_shares_note_id             ON note_shares(note_id);
CREATE INDEX idx_note_shares_shared_with_user_id ON note_shares(shared_with_user_id);
CREATE INDEX idx_note_shares_shared_by_user_id   ON note_shares(shared_by_user_id);

-- Sessions table
CREATE TABLE sessions (
    token      TEXT      PRIMARY KEY,
    user_id    TEXT      NOT NULL,
    user_agent TEXT      NOT NULL DEFAULT '',
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user_id    ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- User settings table
CREATE TABLE user_settings (
    user_id    TEXT      NOT NULL PRIMARY KEY,
    language   TEXT      NOT NULL DEFAULT 'system' CHECK (language IN ('system', 'en', 'de', 'es', 'fr', 'pt', 'it', 'nl', 'pl')),
    theme      TEXT      NOT NULL DEFAULT 'system' CONSTRAINT user_settings_theme_check CHECK (theme IN ('system', 'light', 'dark')),
    note_sort  TEXT      NOT NULL DEFAULT 'manual' CONSTRAINT user_settings_note_sort_check CHECK (note_sort IN ('manual', 'updated_at', 'created_at')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Labels table (no COLLATE NOCASE; case-insensitive matching done in application layer)
CREATE TABLE labels (
    id         TEXT      PRIMARY KEY,
    user_id    TEXT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT      NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name),
    UNIQUE(id, user_id)
);

CREATE INDEX idx_labels_user_id ON labels(user_id);

-- Note labels table
CREATE TABLE note_labels (
    id         TEXT      NOT NULL PRIMARY KEY,
    note_id    TEXT      NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    label_id   TEXT      NOT NULL,
    user_id    TEXT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(note_id, label_id, user_id),
    FOREIGN KEY (label_id, user_id) REFERENCES labels(id, user_id) ON DELETE CASCADE
);

CREATE INDEX idx_note_labels_note_id  ON note_labels(note_id);
CREATE INDEX idx_note_labels_label_id ON note_labels(label_id);
CREATE INDEX idx_note_labels_user_id  ON note_labels(user_id);

-- Per-user note state
CREATE TABLE note_user_state (
    note_id                 TEXT      NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    user_id                 TEXT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    color                   TEXT      NOT NULL DEFAULT '#ffffff',
    pinned                  BOOLEAN   NOT NULL DEFAULT FALSE,
    archived                BOOLEAN   NOT NULL DEFAULT FALSE,
    position                INTEGER   NOT NULL DEFAULT 0,
    unpinned_position       INTEGER,
    checked_items_collapsed BOOLEAN   NOT NULL DEFAULT FALSE,
    created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (note_id, user_id)
);

CREATE INDEX idx_note_user_state_user ON note_user_state(user_id, archived, pinned, position);

-- Personal access tokens table
CREATE TABLE personal_access_tokens (
    id         TEXT      PRIMARY KEY,
    user_id    TEXT      NOT NULL,
    token_hash TEXT      NOT NULL UNIQUE,
    name       TEXT      NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX idx_pats_user_id ON personal_access_tokens(user_id);

-- Active notes view
CREATE VIEW active_notes AS
    SELECT id, user_id, title, content, note_type, deleted_at, created_at, updated_at
    FROM notes
    WHERE deleted_at IS NULL;
