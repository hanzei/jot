-- Add OIDC/SSO identity to users and relax password_hash to nullable.
-- See the SQLite migration of the same number for the full rationale; the two
-- are identical in intent. On PostgreSQL each change is a one-liner and there
-- is no table-rebuild hazard, because DROP NOT NULL and a partial unique index
-- are both expressible directly.
ALTER TABLE users ADD COLUMN oidc_issuer TEXT;
ALTER TABLE users ADD COLUMN oidc_subject TEXT;

-- Relax password_hash: an SSO-provisioned user has no local password. A NULL
-- hash never authenticates a password login.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Partial unique index: one IdP identity maps to exactly one local account,
-- while any number of local-only users (both columns NULL) coexist. This is the
-- behaviour equivalent of the plain unique index the SQLite migration relies on
-- (SQLite treats NULLs as distinct). Both columns are always written together,
-- so a half-null pair never occurs.
CREATE UNIQUE INDEX idx_users_oidc_identity ON users (oidc_issuer, oidc_subject)
    WHERE oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL;
