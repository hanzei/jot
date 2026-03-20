package models

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

type UserSettings struct {
	UserID    string    `json:"user_id"`
	Language  string    `json:"language"`
	Theme     string    `json:"theme"`
	NoteSort  string    `json:"note_sort" enums:"manual,updated_at,created_at"`
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
		`INSERT INTO user_settings (user_id, language, theme, note_sort) VALUES (?, 'system', 'system', 'manual')
		 ON CONFLICT(user_id) DO NOTHING
		 RETURNING language, theme, note_sort, updated_at`,
		userID,
	).Scan(&settings.Language, &settings.Theme, &settings.NoteSort, &settings.UpdatedAt)
	if err == nil {
		return settings, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("failed to get or create user settings: %w", err)
	}
	// Row already existed; read it.
	err = s.db.QueryRow(
		`SELECT language, theme, note_sort, updated_at FROM user_settings WHERE user_id = ?`,
		userID,
	).Scan(&settings.Language, &settings.Theme, &settings.NoteSort, &settings.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to get or create user settings: %w", err)
	}
	return settings, nil
}

// Update persists the language, theme, and note sort preferences for the given user and
// returns the updated settings.
func (s *UserSettingsStore) Update(userID, language, theme, noteSort string) (*UserSettings, error) {
	settings := &UserSettings{UserID: userID}
	err := s.db.QueryRow(
		`INSERT INTO user_settings (user_id, language, theme, note_sort) VALUES (?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET language = excluded.language, theme = excluded.theme, note_sort = excluded.note_sort, updated_at = CURRENT_TIMESTAMP
		 RETURNING language, theme, note_sort, updated_at`,
		userID, language, theme, noteSort,
	).Scan(&settings.Language, &settings.Theme, &settings.NoteSort, &settings.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to update user settings: %w", err)
	}
	return settings, nil
}
