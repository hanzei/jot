-- Depends on 017_add_note_sort_to_user_settings.sql having run first.
CREATE TABLE user_settings_new (
  user_id TEXT NOT NULL PRIMARY KEY,
  language TEXT NOT NULL DEFAULT 'system' CHECK (language IN ('system', 'en', 'de', 'es', 'fr', 'pt', 'it', 'nl', 'pl')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  theme TEXT NOT NULL DEFAULT 'system' CONSTRAINT user_settings_theme_check CHECK (theme IN ('system', 'light', 'dark')),
  note_sort TEXT NOT NULL DEFAULT 'manual' CONSTRAINT user_settings_note_sort_check CHECK (note_sort IN ('manual', 'updated_at', 'created_at')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO user_settings_new (user_id, language, created_at, updated_at, theme, note_sort)
SELECT
  us.user_id,
  CASE
    WHEN us.language IN ('system', 'en', 'de', 'es', 'fr', 'pt', 'it', 'nl', 'pl') THEN us.language
    ELSE 'system'
  END,
  us.created_at,
  us.updated_at,
  CASE
    WHEN us.theme IN ('system', 'light', 'dark') THEN us.theme
    ELSE 'system'
  END,
  CASE
    WHEN us.note_sort IN ('manual', 'updated_at', 'created_at') THEN us.note_sort
    ELSE 'manual'
  END
FROM user_settings us
WHERE EXISTS (
  SELECT 1
  FROM users
  WHERE users.id = us.user_id
);

DROP TABLE user_settings;
ALTER TABLE user_settings_new RENAME TO user_settings;
