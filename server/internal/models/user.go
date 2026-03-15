package models

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	sqlite3 "github.com/mattn/go-sqlite3"
	"github.com/sirupsen/logrus"
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

// ErrCannotDeleteSelf is returned when an admin tries to delete their own account.
var ErrCannotDeleteSelf = errors.New("cannot delete your own account")

type User struct {
	ID             string    `json:"id"`
	Username       string    `json:"username"`
	FirstName      string    `json:"first_name"`
	LastName       string    `json:"last_name"`
	PasswordHash   string    `json:"-"`
	Role           string    `json:"role"`
	HasProfileIcon bool      `json:"has_profile_icon"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
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
	query := `SELECT id, username, first_name, last_name, password_hash, role,
			         profile_icon IS NOT NULL AS has_profile_icon,
			         created_at, updated_at
			  FROM users WHERE username = ?`

	err := s.db.QueryRow(query, username).Scan(
		&user.ID, &user.Username, &user.FirstName, &user.LastName, &user.PasswordHash,
		&user.Role, &user.HasProfileIcon, &user.CreatedAt, &user.UpdatedAt,
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
	query := `SELECT id, username, first_name, last_name, password_hash, role,
			         profile_icon IS NOT NULL AS has_profile_icon,
			         created_at, updated_at
			  FROM users WHERE id = ?`

	err := s.db.QueryRow(query, id).Scan(
		&user.ID, &user.Username, &user.FirstName, &user.LastName, &user.PasswordHash,
		&user.Role, &user.HasProfileIcon, &user.CreatedAt, &user.UpdatedAt,
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
	query := `SELECT id, username, first_name, last_name, password_hash, role,
			         profile_icon IS NOT NULL AS has_profile_icon,
			         created_at, updated_at
			  FROM users ORDER BY created_at DESC`

	rows, err := s.db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("failed to query users: %w", err)
	}
	defer func() {
		if err = rows.Close(); err != nil {
			logrus.WithError(err).Error("Failed to close rows")
		}
	}()

	var users []*User
	for rows.Next() {
		var user User
		if err = rows.Scan(
			&user.ID, &user.Username, &user.FirstName, &user.LastName, &user.PasswordHash,
			&user.Role, &user.HasProfileIcon, &user.CreatedAt, &user.UpdatedAt,
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
			  WHERE id = ? RETURNING id, username, first_name, last_name, role,
			  profile_icon IS NOT NULL AS has_profile_icon,
			  created_at, updated_at`
	var user User
	err := s.db.QueryRow(query, newUsername, id).Scan(
		&user.ID, &user.Username, &user.FirstName, &user.LastName, &user.Role, &user.HasProfileIcon, &user.CreatedAt, &user.UpdatedAt,
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

func (s *UserStore) UpdateProfileIcon(id string, data []byte, contentType string) error {
	if len(data) == 0 {
		return errors.New("profile icon data must not be empty")
	}
	if contentType == "" {
		return errors.New("profile icon content type must not be empty")
	}
	result, err := s.db.Exec(
		`UPDATE users SET profile_icon = ?, profile_icon_content_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		data, contentType, id,
	)
	if err != nil {
		return fmt.Errorf("failed to update profile icon: %w", err)
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

func (s *UserStore) GetProfileIcon(id string) ([]byte, string, error) {
	var data []byte
	var contentType sql.NullString
	err := s.db.QueryRow(
		`SELECT profile_icon, profile_icon_content_type FROM users WHERE id = ?`, id,
	).Scan(&data, &contentType)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, "", ErrUserNotFound
		}
		return nil, "", fmt.Errorf("failed to get profile icon: %w", err)
	}
	if len(data) == 0 {
		return nil, "", nil
	}
	return data, contentType.String, nil
}

func (s *UserStore) DeleteProfileIcon(id string) error {
	result, err := s.db.Exec(
		`UPDATE users SET profile_icon = NULL, profile_icon_content_type = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		id,
	)
	if err != nil {
		return fmt.Errorf("failed to delete profile icon: %w", err)
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

func (s *UserStore) UpdateName(id, firstName, lastName string) (*User, error) {
	query := `UPDATE users SET first_name = ?, last_name = ?, updated_at = CURRENT_TIMESTAMP
			  WHERE id = ? RETURNING id, username, first_name, last_name, role,
			  profile_icon IS NOT NULL AS has_profile_icon,
			  created_at, updated_at`
	var user User
	err := s.db.QueryRow(query, firstName, lastName, id).Scan(
		&user.ID, &user.Username, &user.FirstName, &user.LastName, &user.Role, &user.HasProfileIcon, &user.CreatedAt, &user.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("failed to update name: %w", err)
	}
	return &user, nil
}

// UpdateProfile atomically updates the username, first name, and last name for
// the given user in a single transaction. Returns ErrUsernameTaken if the new
// username conflicts with an existing account, or ErrUserNotFound if the id
// does not exist.
func (s *UserStore) UpdateProfile(id, username, firstName, lastName string) (*User, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var user User
	err = tx.QueryRow(
		`UPDATE users SET username = ?, first_name = ?, last_name = ?, updated_at = CURRENT_TIMESTAMP
		 WHERE id = ? RETURNING id, username, first_name, last_name, role,
		 profile_icon IS NOT NULL AS has_profile_icon,
		 created_at, updated_at`,
		username, firstName, lastName, id,
	).Scan(&user.ID, &user.Username, &user.FirstName, &user.LastName, &user.Role, &user.HasProfileIcon, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		var sqliteErr sqlite3.Error
		if errors.As(err, &sqliteErr) && sqliteErr.ExtendedCode == sqlite3.ErrConstraintUnique {
			return nil, ErrUsernameTaken
		}
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("failed to update profile: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("failed to commit transaction: %w", err)
	}
	return &user, nil
}

func (s *UserStore) UpdateRole(id, role string) (*User, error) {
	if role != RoleUser && role != RoleAdmin {
		return nil, fmt.Errorf("invalid role %q: must be %q or %q", role, RoleUser, RoleAdmin)
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
		 WHERE id = ? RETURNING id, username, first_name, last_name, role,
		 profile_icon IS NOT NULL AS has_profile_icon,
		 created_at, updated_at`,
		role, id,
	).Scan(&user.ID, &user.Username, &user.FirstName, &user.LastName, &user.Role, &user.HasProfileIcon, &user.CreatedAt, &user.UpdatedAt)
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

func (s *UserStore) Delete(id, requestingUserID string) error {
	if id == requestingUserID {
		return fmt.Errorf("%w", ErrCannotDeleteSelf)
	}

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var role string
	err = tx.QueryRow(`SELECT role FROM users WHERE id = ?`, id).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("%w", ErrUserNotFound)
	}
	if err != nil {
		return fmt.Errorf("failed to query user role: %w", err)
	}

	if role == RoleAdmin {
		var adminCount int
		if err = tx.QueryRow(`SELECT COUNT(*) FROM users WHERE role = 'admin'`).Scan(&adminCount); err != nil {
			return fmt.Errorf("failed to count admins: %w", err)
		}
		if adminCount <= 1 {
			return fmt.Errorf("%w", ErrLastAdmin)
		}
	}

	// Clear item assignments inline (not via NoteStore) to keep it within the same transaction.
	if _, err = tx.Exec(`UPDATE note_items SET assigned_to_user_id = '', updated_at = CURRENT_TIMESTAMP WHERE assigned_to_user_id = ?`, id); err != nil {
		return fmt.Errorf("failed to clear user assignments: %w", err)
	}

	result, err := tx.Exec(`DELETE FROM users WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("failed to delete user: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if rows == 0 {
		return fmt.Errorf("%w", ErrUserNotFound)
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}
	return nil
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

