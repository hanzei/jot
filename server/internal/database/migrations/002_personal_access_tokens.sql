CREATE TABLE personal_access_tokens (
    id         TEXT     PRIMARY KEY,
    user_id    TEXT     NOT NULL,
    token_hash TEXT     NOT NULL UNIQUE,
    name       TEXT     NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX idx_pats_user_id ON personal_access_tokens(user_id);
