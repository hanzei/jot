package models

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/hanzei/jot/server/internal/database/dialect"
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

type userStore struct {
	db *sql.DB
	d  *dialect.Dialect
}

func newUserStore(db *sql.DB, d *dialect.Dialect) *userStore {
	return &userStore{db: db, d: d}
}

func (s *userStore) Create(ctx context.Context, username, password string) (*User, error) {
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	userID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate user ID: %w", err)
	}

	// Wrap the COUNT + INSERT in a transaction to make first-user admin assignment
	// atomic. SQLite serializes all writes through a single connection
	// (SetMaxOpenConns(1) in database.go), so a plain transaction is sufficient
	// to prevent two concurrent registrations from both reading count == 0.
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var count int
	if err = tx.QueryRowContext(ctx, s.d.RewritePlaceholders("SELECT COUNT(*) FROM users")).Scan(&count); err != nil {
		return nil, fmt.Errorf("failed to count users: %w", err)
	}

	role := RoleUser
	if count == 0 {
		role = RoleAdmin
	}

	query := `INSERT INTO users (id, username, password_hash, role)
			  VALUES (?, ?, ?, ?) RETURNING created_at, updated_at`

	var user User
	err = tx.QueryRowContext(ctx, s.d.RewritePlaceholders(query), userID, username, string(hashedPassword), role).Scan(
		&user.CreatedAt, &user.UpdatedAt,
	)
	if err != nil {
		if s.d.IsUniqueConstraintError(err) {
			return nil, ErrUsernameTaken
		}
		return nil, fmt.Errorf("failed to create user: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit transaction: %w", err)
	}

	user.ID = userID
	user.Username = username
	user.Role = role

	return &user, nil
}

func (s *userStore) GetByUsername(ctx context.Context, username string) (*User, error) {
	var user User
	query := `SELECT id, username, first_name, last_name, password_hash, role,
			         profile_icon IS NOT NULL AS has_profile_icon,
			         created_at, updated_at
			  FROM users WHERE username = ?`

	err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(query), username).Scan(
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

func (s *userStore) GetByID(ctx context.Context, id string) (*User, error) {
	var user User
	query := `SELECT id, username, first_name, last_name, password_hash, role,
			         profile_icon IS NOT NULL AS has_profile_icon,
			         created_at, updated_at
			  FROM users WHERE id = ?`

	err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(query), id).Scan(
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

func scanUser(rows *sql.Rows) (User, error) {
	var user User
	err := rows.Scan(
		&user.ID, &user.Username, &user.FirstName, &user.LastName, &user.PasswordHash,
		&user.Role, &user.HasProfileIcon, &user.CreatedAt, &user.UpdatedAt,
	)
	return user, err
}

func (s *userStore) GetAll(ctx context.Context) ([]*User, error) {
	query := `SELECT id, username, first_name, last_name, password_hash, role,
			         profile_icon IS NOT NULL AS has_profile_icon,
			         created_at, updated_at
			  FROM users ORDER BY created_at DESC`

	rows, err := s.db.QueryContext(ctx, s.d.RewritePlaceholders(query))
	if err != nil {
		return nil, fmt.Errorf("failed to query users: %w", err)
	}

	users, err := collectRows(rows, scanUser)
	if err != nil {
		return nil, fmt.Errorf("failed to scan users: %w", err)
	}

	ptrs := make([]*User, len(users))
	for i := range users {
		ptrs[i] = &users[i]
	}
	return ptrs, nil
}

// Search returns users whose username, first name, or last name contain the
// given search term (case-insensitive). Results are ordered by creation date
// descending.
func (s *userStore) Search(ctx context.Context, term string) ([]*User, error) {
	like := "%" + term + "%"
	query := `SELECT id, username, first_name, last_name, password_hash, role,
			         profile_icon IS NOT NULL AS has_profile_icon,
			         created_at, updated_at
			  FROM users
			  WHERE username LIKE ? OR first_name LIKE ? OR last_name LIKE ?
			  ORDER BY created_at DESC`

	rows, err := s.db.QueryContext(ctx, s.d.RewritePlaceholders(query), like, like, like)
	if err != nil {
		return nil, fmt.Errorf("failed to search users: %w", err)
	}

	users, err := collectRows(rows, scanUser)
	if err != nil {
		return nil, fmt.Errorf("failed to scan users: %w", err)
	}

	ptrs := make([]*User, len(users))
	for i := range users {
		ptrs[i] = &users[i]
	}
	return ptrs, nil
}

// UpdateUsername sets a new username for the user with the given id and returns
// the updated user. Returns ErrUsernameTaken if the username is already in use,
// or another error if the id does not exist or the query fails.
func (s *userStore) UpdateUsername(ctx context.Context, id, newUsername string) (*User, error) {
	query := `UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP
			  WHERE id = ? RETURNING id, username, first_name, last_name, role,
			  profile_icon IS NOT NULL AS has_profile_icon,
			  created_at, updated_at`
	var user User
	err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(query), newUsername, id).Scan(
		&user.ID, &user.Username, &user.FirstName, &user.LastName, &user.Role, &user.HasProfileIcon, &user.CreatedAt, &user.UpdatedAt,
	)
	if err != nil {
		if s.d.IsUniqueConstraintError(err) {
			return nil, ErrUsernameTaken
		}
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("failed to update username: %w", err)
	}
	return &user, nil
}

func (s *userStore) UpdateProfileIcon(ctx context.Context, id string, data []byte, contentType string) error {
	if len(data) == 0 {
		return errors.New("profile icon data must not be empty")
	}
	if contentType == "" {
		return errors.New("profile icon content type must not be empty")
	}
	result, err := s.db.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE users SET profile_icon = ?, profile_icon_content_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`),
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

func (s *userStore) GetProfileIcon(ctx context.Context, id string) ([]byte, string, error) {
	var data []byte
	var contentType sql.Null[string]
	err := s.db.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`SELECT profile_icon, profile_icon_content_type FROM users WHERE id = ?`), id,
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
	return data, contentType.V, nil
}

func (s *userStore) DeleteProfileIcon(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE users SET profile_icon = NULL, profile_icon_content_type = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`),
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

func (s *userStore) UpdatePassword(ctx context.Context, id, newPassword string) error {
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}

	result, err := s.db.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`),
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

func (s *userStore) UpdateName(ctx context.Context, id, firstName, lastName string) (*User, error) {
	query := `UPDATE users SET first_name = ?, last_name = ?, updated_at = CURRENT_TIMESTAMP
			  WHERE id = ? RETURNING id, username, first_name, last_name, role,
			  profile_icon IS NOT NULL AS has_profile_icon,
			  created_at, updated_at`
	var user User
	err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(query), firstName, lastName, id).Scan(
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
func (s *userStore) UpdateProfile(ctx context.Context, id, username, firstName, lastName string) (*User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var user User
	err = tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`UPDATE users SET username = ?, first_name = ?, last_name = ?, updated_at = CURRENT_TIMESTAMP
		 WHERE id = ? RETURNING id, username, first_name, last_name, role,
		 profile_icon IS NOT NULL AS has_profile_icon,
		 created_at, updated_at`),
		username, firstName, lastName, id,
	).Scan(&user.ID, &user.Username, &user.FirstName, &user.LastName, &user.Role, &user.HasProfileIcon, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		if s.d.IsUniqueConstraintError(err) {
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

func (s *userStore) UpdateRole(ctx context.Context, id, role string) (*User, error) {
	if role != RoleUser && role != RoleAdmin {
		return nil, fmt.Errorf("invalid role %q: must be %q or %q", role, RoleUser, RoleAdmin)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Guard: if we're demoting an admin to user, ensure they're not the last admin.
	if role == RoleUser {
		var currentRole string
		err = tx.QueryRowContext(ctx, s.d.RewritePlaceholders(`SELECT role FROM users WHERE id = ?`), id).Scan(&currentRole)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("%w", ErrUserNotFound)
		}
		if err != nil {
			return nil, fmt.Errorf("failed to query current role: %w", err)
		}
		if currentRole == RoleAdmin {
			var adminCount int
			if err = tx.QueryRowContext(ctx, s.d.RewritePlaceholders(`SELECT COUNT(*) FROM users WHERE role = 'admin'`)).Scan(&adminCount); err != nil {
				return nil, fmt.Errorf("failed to count admins: %w", err)
			}
			if adminCount <= 1 {
				return nil, fmt.Errorf("%w", ErrLastAdmin)
			}
		}
	}

	var user User
	err = tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP
		 WHERE id = ? RETURNING id, username, first_name, last_name, role,
		 profile_icon IS NOT NULL AS has_profile_icon,
		 created_at, updated_at`),
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

func (s *userStore) Delete(ctx context.Context, id, requestingUserID string) error {
	return s.DeleteWithCleanup(ctx, id, requestingUserID, nil)
}

// DeleteWithCleanup deletes a user and runs an optional postDelete callback
// inside the same transaction. The callback executes after the user row is
// deleted (and cascade effects like note_shares removal have taken place) but
// before the transaction commits, so any cleanup is atomic with the delete.
func (s *userStore) DeleteWithCleanup(ctx context.Context, id, requestingUserID string, postDelete func(ctx context.Context, tx *sql.Tx) error) error {
	if id == requestingUserID {
		return fmt.Errorf("%w", ErrCannotDeleteSelf)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var role string
	err = tx.QueryRowContext(ctx, s.d.RewritePlaceholders(`SELECT role FROM users WHERE id = ?`), id).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("%w", ErrUserNotFound)
	}
	if err != nil {
		return fmt.Errorf("failed to query user role: %w", err)
	}

	if role == RoleAdmin {
		var adminCount int
		if err = tx.QueryRowContext(ctx, s.d.RewritePlaceholders(`SELECT COUNT(*) FROM users WHERE role = 'admin'`)).Scan(&adminCount); err != nil {
			return fmt.Errorf("failed to count admins: %w", err)
		}
		if adminCount <= 1 {
			return fmt.Errorf("%w", ErrLastAdmin)
		}
	}

	result, err := tx.ExecContext(ctx, s.d.RewritePlaceholders(`DELETE FROM users WHERE id = ?`), id)
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

	if postDelete != nil {
		if err = postDelete(ctx, tx); err != nil {
			return fmt.Errorf("post-delete cleanup failed: %w", err)
		}
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}
	return nil
}

func (s *userStore) CreateByAdmin(ctx context.Context, username, password string, role string) (*User, error) {
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
	err = s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(query), userID, username, string(hashedPassword), role).Scan(
		&user.CreatedAt, &user.UpdatedAt,
	)
	if err != nil {
		if s.d.IsUniqueConstraintError(err) {
			return nil, ErrUsernameTaken
		}
		return nil, fmt.Errorf("failed to create user: %w", err)
	}

	user.ID = userID
	user.Username = username
	user.Role = role

	return &user, nil
}
