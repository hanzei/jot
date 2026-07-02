-- Store session tokens hashed (SHA-256 hex) instead of in plaintext, so a
-- leaked database file or backup does not yield usable session cookies.
-- Existing plaintext tokens cannot be converted in place (the hash is
-- one-way and must be computed from the raw token), so all existing
-- sessions are deleted; every user has to log in again once.
DELETE FROM sessions;

ALTER TABLE sessions RENAME COLUMN token TO token_hash;
