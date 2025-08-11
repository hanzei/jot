-- Add username column to users table (without UNIQUE constraint initially)
ALTER TABLE users ADD COLUMN username TEXT;

-- Set a default username based on email (temporary, will be updated during registration)
UPDATE users SET username = SUBSTR(email, 1, INSTR(email, '@') - 1) WHERE username IS NULL;

-- Create a unique index on username column
CREATE UNIQUE INDEX idx_users_username ON users(username);