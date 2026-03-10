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
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("user not found")
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
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("user not found")
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
			return nil, fmt.Errorf("user not found")
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
		return fmt.Errorf("user not found")
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

