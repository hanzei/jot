CREATE TABLE user_settings_new (
  user_id TEXT NOT NULL PRIMARY KEY,
  language TEXT NOT NULL DEFAULT 'system' CHECK (language IN ('system', 'en', 'de')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  theme TEXT NOT NULL DEFAULT 'system',
  note_sort TEXT NOT NULL DEFAULT 'manual' CHECK (note_sort IN ('manual', 'updated_at', 'created_at', 'title')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO user_settings_new (user_id, language, created_at, updated_at, theme, note_sort)
SELECT user_id, language, created_at, updated_at, theme, note_sort
FROM user_settings;

DROP TABLE user_settings;
ALTER TABLE user_settings_new RENAME TO user_settings;
