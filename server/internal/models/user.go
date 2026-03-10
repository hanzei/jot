package models

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"time"

	sqlite3 "github.com/mattn/go-sqlite3"
	"golang.org/x/crypto/bcrypt"
)

// ErrUsernameTaken is returned by UpdateUsername when the requested username is
// already in use by another account.
var ErrUsernameTaken = errors.New("username already taken")

// ErrUserNotFound is returned when a user lookup or update targets an ID that
// does not exist in the database.
var ErrUserNotFound = errors.New("user not found")

// ErrLastAdmin is returned when an attempt is made to demote the only remaining
// admin user, which would leave the system with no administrators.
var ErrLastAdmin = errors.New("cannot demote the last admin")

// ErrInvalidRole is returned when an unrecognized role value is supplied.
var ErrInvalidRole = errors.New("invalid role")

type User struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	PasswordHash string    `json:"-"`
	Role         string    `json:"role"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type UserStore struct {
	db *sql.DB
}

func NewUserStore(db *sql.DB) *UserStore {
	return &UserStore{db: db}
}


func (s *UserStore) Create(username, password string) (*User, error) {
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	userID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate user ID: %w", err)
	}

	var isFirstUser bool
	var count int
	err = s.db.QueryRow("SELECT COUNT(*) FROM users").Scan(&count)
	if err != nil {
		return nil, fmt.Errorf("failed to count users: %w", err)
	}
	isFirstUser = count == 0

	role := RoleUser
	if isFirstUser {
		role = RoleAdmin
	}

	query := `INSERT INTO users (id, username, password_hash, role) 
			  VALUES (?, ?, ?, ?) RETURNING created_at, updated_at`

	var user User
	err = s.db.QueryRow(query, userID, username, string(hashedPassword), role).Scan(
		&user.CreatedAt, &user.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create user: %w", err)
	}

	user.ID = userID
	user.Username = username
	user.Role = role

	return &user, nil
}

func (s *UserStore) GetByUsername(username string) (*User, error) {
	var user User
	query := `SELECT id, username, password_hash, role, created_at, updated_at 
			  FROM users WHERE username = ?`

	err := s.db.QueryRow(query, username).Scan(
		&user.ID, &user.Username, &user.PasswordHash,
		&user.Role, &user.CreatedAt, &user.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("failed to get user: %w", err)
	}
	return &user, nil
}

func (s *UserStore) GetByID(id string) (*User, error) {
	var user User
	query := `SELECT id, username, password_hash, role, created_at, updated_at 
			  FROM users WHERE id = ?`

	err := s.db.QueryRow(query, id).Scan(
		&user.ID, &user.Username, &user.PasswordHash,
		&user.Role, &user.CreatedAt, &user.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("failed to get user: %w", err)
	}

	return &user, nil
}

func (u *User) CheckPassword(password string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(password))
	return err == nil
}

func (s *UserStore) GetAll() ([]*User, error) {
	query := `SELECT id, username, password_hash, role, created_at, updated_at 
			  FROM users ORDER BY created_at DESC`

	rows, err := s.db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("failed to query users: %w", err)
	}
	defer func() {
		if err = rows.Close(); err != nil {
			log.Printf("Failed to close rows: %v", err)
		}
	}()

	var users []*User
	for rows.Next() {
		var user User
		if err = rows.Scan(
			&user.ID, &user.Username, &user.PasswordHash,
			&user.Role, &user.CreatedAt, &user.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan user: %w", err)
		}
		users = append(users, &user)
	}

	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating users: %w", err)
	}

	return users, nil
}

// UpdateUsername sets a new username for the user with the given id and returns
// the updated user. Returns ErrUsernameTaken if the username is already in use,
// or another error if the id does not exist or the query fails.
func (s *UserStore) UpdateUsername(id, newUsername string) (*User, error) {
	query := `UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP
			  WHERE id = ? RETURNING id, username, role, created_at, updated_at`
	var user User
	err := s.db.QueryRow(query, newUsername, id).Scan(
		&user.ID, &user.Username, &user.Role, &user.CreatedAt, &user.UpdatedAt,
	)
	if err != nil {
		var sqliteErr sqlite3.Error
		if errors.As(err, &sqliteErr) && sqliteErr.ExtendedCode == sqlite3.ErrConstraintUnique {
			return nil, ErrUsernameTaken
		}
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("failed to update username: %w", err)
	}
	return &user, nil
}

func (s *UserStore) UpdatePassword(id, newPassword string) error {
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}

	result, err := s.db.Exec(
		`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		string(hashedPassword), id,
	)
	if err != nil {
		return fmt.Errorf("failed to update password: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if rows == 0 {
		return ErrUserNotFound
	}

	return nil
}

type UserSettings struct {
	UserID    string    `json:"user_id"`
	Language  string    `json:"language"`
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
		`INSERT INTO user_settings (user_id, language) VALUES (?, 'system')
		 ON CONFLICT(user_id) DO UPDATE SET user_id = excluded.user_id
		 RETURNING language, updated_at`,
		userID,
	).Scan(&settings.Language, &settings.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to get or create user settings: %w", err)
	}
	return settings, nil
}

// Update persists the language preference for the given user and returns the
// updated settings.
func (s *UserSettingsStore) Update(userID, language string) (*UserSettings, error) {
	settings := &UserSettings{UserID: userID}
	err := s.db.QueryRow(
		`INSERT INTO user_settings (user_id, language) VALUES (?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET language = excluded.language, updated_at = CURRENT_TIMESTAMP
		 RETURNING language, updated_at`,
		userID, language,
	).Scan(&settings.Language, &settings.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to update user settings: %w", err)
	}
	return settings, nil
}

func (s *UserStore) UpdateRole(id, role string) (*User, error) {
	if role != RoleUser && role != RoleAdmin {
		return nil, fmt.Errorf("invalid role %q: must be %q or %q: %w", role, RoleUser, RoleAdmin, ErrInvalidRole)
	}

	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Guard: if we're demoting an admin to user, ensure they're not the last admin.
	if role == RoleUser {
		var currentRole string
		err = tx.QueryRow(`SELECT role FROM users WHERE id = ?`, id).Scan(&currentRole)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("%w", ErrUserNotFound)
		}
		if err != nil {
			return nil, fmt.Errorf("failed to query current role: %w", err)
		}
		if currentRole == RoleAdmin {
			var adminCount int
			if err = tx.QueryRow(`SELECT COUNT(*) FROM users WHERE role = 'admin'`).Scan(&adminCount); err != nil {
				return nil, fmt.Errorf("failed to count admins: %w", err)
			}
			if adminCount <= 1 {
				return nil, fmt.Errorf("%w", ErrLastAdmin)
			}
		}
	}

	var user User
	err = tx.QueryRow(
		`UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP
		 WHERE id = ? RETURNING id, username, role, created_at, updated_at`,
		role, id,
	).Scan(&user.ID, &user.Username, &user.Role, &user.CreatedAt, &user.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w", ErrUserNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to update role: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("failed to commit transaction: %w", err)
	}
	return &user, nil
}

func (s *UserStore) CreateByAdmin(username, password string, role string) (*User, error) {
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	userID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate user ID: %w", err)
	}

	query := `INSERT INTO users (id, username, password_hash, role) 
			  VALUES (?, ?, ?, ?) RETURNING created_at, updated_at`

	var user User
	err = s.db.QueryRow(query, userID, username, string(hashedPassword), role).Scan(
		&user.CreatedAt, &user.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create user: %w", err)
	}

	user.ID = userID
	user.Username = username
	user.Role = role

	return &user, nil
}

