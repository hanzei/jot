-- SQLite doesn't support ALTER COLUMN directly, so we need to recreate the table
-- First, create a backup of the users table
CREATE TABLE users_backup AS SELECT * FROM users;

-- Drop the original table
DROP TABLE users;

-- Recreate the users table with nullable email
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Restore the data
INSERT INTO users SELECT * FROM users_backup;

-- Drop the backup table
DROP TABLE users_backup;