package models

import (
	"database/sql"
	"fmt"
	"log"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type User struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	PasswordHash string    `json:"-"`
	IsAdmin      bool      `json:"is_admin"`
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

	query := `INSERT INTO users (id, username, password_hash, is_admin) 
			  VALUES (?, ?, ?, ?) RETURNING created_at, updated_at`

	var user User
	err = s.db.QueryRow(query, userID, username, string(hashedPassword), isFirstUser).Scan(
		&user.CreatedAt, &user.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create user: %w", err)
	}

	user.ID = userID
	user.Username = username
	user.IsAdmin = isFirstUser

	return &user, nil
}

func (s *UserStore) GetByUsername(username string) (*User, error) {
	var user User
	query := `SELECT id, username, password_hash, is_admin, created_at, updated_at 
			  FROM users WHERE username = ?`

	err := s.db.QueryRow(query, username).Scan(
		&user.ID, &user.Username, &user.PasswordHash,
		&user.IsAdmin, &user.CreatedAt, &user.UpdatedAt,
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
	query := `SELECT id, username, password_hash, is_admin, created_at, updated_at 
			  FROM users WHERE id = ?`

	err := s.db.QueryRow(query, id).Scan(
		&user.ID, &user.Username, &user.PasswordHash,
		&user.IsAdmin, &user.CreatedAt, &user.UpdatedAt,
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
	query := `SELECT id, username, password_hash, is_admin, created_at, updated_at 
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
			&user.IsAdmin, &user.CreatedAt, &user.UpdatedAt,
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

func (s *UserStore) CreateByAdmin(username, password string, isAdmin bool) (*User, error) {
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	userID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate user ID: %w", err)
	}

	query := `INSERT INTO users (id, username, password_hash, is_admin) 
			  VALUES (?, ?, ?, ?) RETURNING created_at, updated_at`

	var user User
	err = s.db.QueryRow(query, userID, username, string(hashedPassword), isAdmin).Scan(
		&user.CreatedAt, &user.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create user: %w", err)
	}

	user.ID = userID
	user.Username = username
	user.IsAdmin = isAdmin

	return &user, nil
}

