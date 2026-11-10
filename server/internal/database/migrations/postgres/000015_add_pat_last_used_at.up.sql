-- When a personal access token last authenticated a request (#1228).
--
-- NULL until the first use recorded after this migration, so for a token that
-- predates it NULL means "no recorded use", not "never used". The auth
-- middleware only writes when the stored value is more than an hour old,
-- so the value is accurate to the hour, not to the request.
ALTER TABLE personal_access_tokens ADD COLUMN last_used_at TIMESTAMP;
