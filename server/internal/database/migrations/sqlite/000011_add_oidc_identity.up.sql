-- Add OIDC/SSO identity to users and relax password_hash to nullable.
--
-- Three changes, all of which must land identically in behaviour on both
-- backends (see the postgres migration of the same number):
--   1. two nullable columns, oidc_issuer + oidc_subject, holding the IdP the
--      account belongs to and its stable `sub` claim;
--   2. a unique index over (oidc_issuer, oidc_subject) so one IdP identity maps
--      to exactly one local account;
--   3. password_hash becomes nullable, because an SSO-provisioned user has no
--      local password (a NULL hash never authenticates a password login).
--
-- SQLite has no "DROP NOT NULL", so relaxing password_hash requires the
-- table-rebuild pattern (create users_new, copy, drop, rename) already used by
-- 000008. This rebuild does all three changes at once: users_new is declared
-- with the two new columns and a nullable password_hash, and the indexes are
-- recreated afterwards.
--
-- THE HAZARD, and why this migration is safe only because of a startup change.
-- `users` is the schema's most-referenced parent table: notes, note_items,
-- note_shares, note_images, sessions, personal_access_tokens, labels,
-- note_labels, note_user_state, and user_settings all reference it with
-- ON DELETE CASCADE. With PRAGMA foreign_keys = ON, `DROP TABLE users` would
-- implicitly DELETE every row first and cascade-delete every user's notes.
-- The pragma cannot be toggled inside a migration — golang-migrate wraps each
-- migration in a transaction and SQLite ignores foreign_keys changes inside one
-- — so this rebuild is only safe because database.New now runs migrations with
-- foreign_keys OFF (SQLite's default, and the state its docs recommend for
-- schema-change rebuilds), runs PRAGMA foreign_key_check afterwards, and only
-- then enables enforcement. See internal/database/database.go.
CREATE TABLE users_new (
    id                        TEXT PRIMARY KEY,
    username                  TEXT NOT NULL,
    password_hash             TEXT,
    role                      TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    first_name                TEXT NOT NULL DEFAULT '',
    last_name                 TEXT NOT NULL DEFAULT '',
    profile_icon              BLOB,
    profile_icon_content_type TEXT,
    oidc_issuer               TEXT,
    oidc_subject              TEXT,
    created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users_new (id, username, password_hash, role, first_name, last_name, profile_icon, profile_icon_content_type, created_at, updated_at)
SELECT id, username, password_hash, role, first_name, last_name, profile_icon, profile_icon_content_type, created_at, updated_at
FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;

CREATE UNIQUE INDEX idx_users_username ON users(username);

-- SQLite treats NULLs as distinct in a unique index, so this permits any number
-- of local-only users (both columns NULL) while still rejecting a second
-- account bound to the same (issuer, subject) pair. Both columns are always
-- written together, so a half-null pair never occurs. This matches the partial
-- index the postgres migration uses.
CREATE UNIQUE INDEX idx_users_oidc_identity ON users(oidc_issuer, oidc_subject);
