package models

import (
	"database/sql"
	"fmt"
	"time"
)

type UserSettings struct {
	UserID    string    `json:"user_id"`
	Language  string    `json:"language"`
	Theme     string    `json:"theme"`
	UpdatedAt time.Time `json:"updated_at"`
}

type UserSettingsStore struct {
	db *sql.DB
}

func NewUserSettingsStore(db *sql.DB) *UserSettingsStore {
	return &UserSettingsStore{db: db}
}

// GetOrCreate returns existing settings for the user, or creates a row with
// defaults and returns those. The operation is atomic: if two goroutines race
// to create the row, one will win the INSERT and both will read consistent data.
func (s *UserSettingsStore) GetOrCreate(userID string) (*UserSettings, error) {
	settings := &UserSettings{UserID: userID}
	err := s.db.QueryRow(
		`INSERT INTO user_settings (user_id, language, theme) VALUES (?, 'system', 'system')
		 ON CONFLICT(user_id) DO UPDATE SET user_id = excluded.user_id
		 RETURNING language, theme, updated_at`,
		userID,
	).Scan(&settings.Language, &settings.Theme, &settings.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to get or create user settings: %w", err)
	}
	return settings, nil
}

// Update persists the language and theme preferences for the given user and
// returns the updated settings.
func (s *UserSettingsStore) Update(userID, language, theme string) (*UserSettings, error) {
	settings := &UserSettings{UserID: userID}
	err := s.db.QueryRow(
		`INSERT INTO user_settings (user_id, language, theme) VALUES (?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET language = excluded.language, theme = excluded.theme, updated_at = CURRENT_TIMESTAMP
		 RETURNING language, theme, updated_at`,
		userID, language, theme,
	).Scan(&settings.Language, &settings.Theme, &settings.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to update user settings: %w", err)
	}
	return settings, nil
}
