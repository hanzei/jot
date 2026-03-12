package models

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var ErrDeviceTokenNotFound = errors.New("device token not found")

type DeviceToken struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	Token     string    `json:"token"`
	Platform  string    `json:"platform"`
	CreatedAt time.Time `json:"created_at"`
}

type DeviceTokenStore struct {
	db *sql.DB
}

func NewDeviceTokenStore(db *sql.DB) *DeviceTokenStore {
	return &DeviceTokenStore{db: db}
}

func (s *DeviceTokenStore) Register(userID, token, platform string) (*DeviceToken, error) {
	id, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate device token ID: %w", err)
	}

	query := `
		INSERT INTO device_tokens (id, user_id, token, platform)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform
	`
	if _, err := s.db.Exec(query, id, userID, token, platform); err != nil {
		return nil, fmt.Errorf("failed to register device token: %w", err)
	}

	return s.GetByToken(token)
}

func (s *DeviceTokenStore) GetByToken(token string) (*DeviceToken, error) {
	query := `SELECT id, user_id, token, platform, created_at FROM device_tokens WHERE token = ?`
	row := s.db.QueryRow(query, token)

	dt := &DeviceToken{}
	if err := row.Scan(&dt.ID, &dt.UserID, &dt.Token, &dt.Platform, &dt.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrDeviceTokenNotFound
		}
		return nil, fmt.Errorf("failed to get device token: %w", err)
	}
	return dt, nil
}

func (s *DeviceTokenStore) Delete(userID, token string) error {
	query := `DELETE FROM device_tokens WHERE user_id = ? AND token = ?`
	result, err := s.db.Exec(query, userID, token)
	if err != nil {
		return fmt.Errorf("failed to delete device token: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}
	if rows == 0 {
		return ErrDeviceTokenNotFound
	}
	return nil
}

func (s *DeviceTokenStore) GetByUserID(userID string) ([]*DeviceToken, error) {
	query := `SELECT id, user_id, token, platform, created_at FROM device_tokens WHERE user_id = ?`
	rows, err := s.db.Query(query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to query device tokens: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var tokens []*DeviceToken
	for rows.Next() {
		dt := &DeviceToken{}
		if err := rows.Scan(&dt.ID, &dt.UserID, &dt.Token, &dt.Platform, &dt.CreatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan device token: %w", err)
		}
		tokens = append(tokens, dt)
	}
	return tokens, rows.Err()
}
