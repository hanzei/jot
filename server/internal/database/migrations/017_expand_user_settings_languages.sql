CREATE TABLE user_settings_new (
  user_id TEXT NOT NULL PRIMARY KEY,
  language TEXT NOT NULL DEFAULT 'system' CHECK (language IN ('system', 'en', 'de', 'es', 'fr', 'pt', 'it', 'nl', 'pl')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  theme TEXT NOT NULL DEFAULT 'system' CONSTRAINT user_settings_theme_check CHECK (theme IN ('system', 'light', 'dark')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO user_settings_new (user_id, language, created_at, updated_at, theme)
SELECT
  user_id,
  language,
  created_at,
  updated_at,
  CASE
    WHEN theme IN ('system', 'light', 'dark') THEN theme
    ELSE 'system'
  END
FROM user_settings;

DROP TABLE user_settings;
ALTER TABLE user_settings_new RENAME TO user_settings;
