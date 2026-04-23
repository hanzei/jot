-- Add optional expiration timestamp to personal access tokens.
-- A NULL value means the token never expires; existing tokens keep NULL and
-- remain valid indefinitely until explicitly revoked. Tokens with a non-NULL
-- expires_at are rejected by the auth middleware once the current time is
-- greater than or equal to expires_at.
ALTER TABLE personal_access_tokens
    ADD COLUMN expires_at TIMESTAMP DEFAULT NULL;

CREATE INDEX idx_pats_expires_at ON personal_access_tokens(expires_at);
