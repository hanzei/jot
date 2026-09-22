package models

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/hanzei/jot/server/internal/database/dialect"
	"golang.org/x/crypto/bcrypt"
)

// passwordHashCost is the bcrypt cost every password hash the server writes is
// generated with. Under `go test` it drops to bcrypt.MinCost, because hashing
// at the production cost dominated the integration suite: bcrypt was 65% of
// the root server package's CPU time, and lowering it here cut that suite's
// wall clock from ~74s to ~32s. Cost is not part of any assertion — it is
// carried in the hash's own prefix, so a hash written at MinCost verifies with
// the same CompareHashAndPassword call as one written at DefaultCost, and
// nothing about the auth flow changes shape.
//
// testing.Testing() is false in any binary that is not a test binary, so a
// production server cannot end up on this branch — unlike a config knob, which
// would let a deployment silently weaken its own password hashing.
var passwordHashCost = func() int {
	if testing.Testing() {
		return bcrypt.MinCost
	}
	return bcrypt.DefaultCost
}()

// ErrUsernameTaken is returned by Register, UpdateProfile, and CreateByAdmin
// when the requested username is already in use by another account.
var ErrUsernameTaken = errors.New("username already taken")

// ErrUserNotFound is returned when a user lookup or update targets an ID that
// does not exist in the database.
var ErrUserNotFound = errors.New("user not found")

// ErrLastAdmin is returned when an attempt is made to demote the only remaining
// admin user, which would leave the system with no administrators.
var ErrLastAdmin = errors.New("cannot demote the last admin")

// ErrCannotDeleteSelf is returned when an admin tries to delete their own account.
var ErrCannotDeleteSelf = errors.New("cannot delete your own account")

// ErrOIDCIdentityLinked is returned when an attempt is made to bind an
// (issuer, subject) pair that is already linked to a different user.
var ErrOIDCIdentityLinked = errors.New("this SSO identity is already linked to another account")

// ErrWouldStrandAccount is returned when unlinking an SSO identity would leave
// the user with no way to authenticate — a user whose password_hash is NULL
// (SSO-provisioned, never had a password) must set a password before unlinking.
var ErrWouldStrandAccount = errors.New("cannot unlink SSO: set a password first or the account would have no way to sign in")

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
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), passwordHashCost)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	userID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate user ID: %w", err)
	}

	var isFirstUser bool
	var count int
	err = s.db.QueryRowContext(ctx, s.d.RewritePlaceholders("SELECT COUNT(*) FROM users")).Scan(&count)
	if err != nil {
		return nil, fmt.Errorf("failed to count users: %w", err)
	}
	isFirstUser = count == 0

	role := RoleUser
	if isFirstUser {
		role = RoleAdmin
	}

	now := Timestamp(Now())
	query := `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
			  VALUES (?, ?, ?, ?, ?, ?) RETURNING created_at, updated_at`

	var user User
	err = s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(query), userID, username, string(hashedPassword), role, now, now).Scan(
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

// GetByUsername looks up a user by username, folding the argument to lower case
// first. Stored usernames are lower case by construction — the handlers reject
// anything else — so folding the lookup key is what lets someone who registered
// as "ben" sign in by typing "Ben". ASCII is the whole alphabet here — the
// username character set is [a-z0-9_-] — so strings.ToLower matches the byte
// comparison the query does on either backend, with none of the
// Unicode-collation divergence the label-name fold in
// internal/database/dialect has to reconcile.
func (s *userStore) GetByUsername(ctx context.Context, username string) (*User, error) {
	var user User
	query := `SELECT id, username, first_name, last_name, COALESCE(password_hash, '') AS password_hash, role,
			         profile_icon IS NOT NULL AS has_profile_icon,
			         created_at, updated_at
			  FROM users WHERE username = ?`

	err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(query), strings.ToLower(username)).Scan(
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
	query := `SELECT id, username, first_name, last_name, COALESCE(password_hash, '') AS password_hash, role,
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

// dummyPasswordHash is a bcrypt hash of a throwaway password, generated once
// at startup for CheckPasswordDummy.
var dummyPasswordHash = func() []byte {
	hash, err := bcrypt.GenerateFromPassword([]byte("jot-dummy-timing-equalizer"), passwordHashCost)
	if err != nil {
		panic(fmt.Sprintf("generate dummy password hash: %v", err))
	}
	return hash
}()

// CheckPasswordDummy runs a bcrypt comparison against a throwaway hash and
// discards the result. Login calls it when the username does not exist so
// that the response takes as long as a real password check, preventing a
// timing side channel from revealing which usernames are registered.
func CheckPasswordDummy(password string) {
	_ = bcrypt.CompareHashAndPassword(dummyPasswordHash, []byte(password))
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
	query := `SELECT id, username, first_name, last_name, COALESCE(password_hash, '') AS password_hash, role,
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
// given search term, without regard to case on either backend. Results are
// ordered by creation date descending.
//
// The case folding has to be explicit: a plain LIKE folds ASCII case on SQLite
// but not on PostgreSQL, so the share and assignee pickers would quietly match
// case-sensitively on a PostgreSQL deployment. Usernames are lower case now, but
// first and last names are free-form and still need it.
func (s *userStore) Search(ctx context.Context, term string) ([]*User, error) {
	like := "%" + term + "%"
	query := `SELECT id, username, first_name, last_name, COALESCE(password_hash, '') AS password_hash, role,
			         profile_icon IS NOT NULL AS has_profile_icon,
			         created_at, updated_at
			  FROM users
			  WHERE ` + s.d.CaseInsensitiveLike("username") +
		` OR ` + s.d.CaseInsensitiveLike("first_name") +
		` OR ` + s.d.CaseInsensitiveLike("last_name") +
		` ORDER BY created_at DESC`

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

func (s *userStore) UpdateProfileIcon(ctx context.Context, id string, data []byte, contentType string) error {
	if len(data) == 0 {
		return errors.New("profile icon data must not be empty")
	}
	if contentType == "" {
		return errors.New("profile icon content type must not be empty")
	}
	result, err := s.db.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE users SET profile_icon = ?, profile_icon_content_type = ?, updated_at = ? WHERE id = ?`),
		data, contentType, Timestamp(Now()), id,
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
		s.d.RewritePlaceholders(`UPDATE users SET profile_icon = NULL, profile_icon_content_type = NULL, updated_at = ? WHERE id = ?`),
		Timestamp(Now()), id,
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
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(newPassword), passwordHashCost)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}

	result, err := s.db.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`),
		string(hashedPassword), Timestamp(Now()), id,
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
		s.d.RewritePlaceholders(`UPDATE users SET username = ?, first_name = ?, last_name = ?, updated_at = ?
		 WHERE id = ? RETURNING id, username, first_name, last_name, role,
		 profile_icon IS NOT NULL AS has_profile_icon,
		 created_at, updated_at`),
		username, firstName, lastName, Timestamp(Now()), id,
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
			return nil, ErrUserNotFound
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
				return nil, ErrLastAdmin
			}
		}
	}

	var user User
	err = tx.QueryRowContext(ctx,
		s.d.RewritePlaceholders(`UPDATE users SET role = ?, updated_at = ?
		 WHERE id = ? RETURNING id, username, first_name, last_name, role,
		 profile_icon IS NOT NULL AS has_profile_icon,
		 created_at, updated_at`),
		role, Timestamp(Now()), id,
	).Scan(&user.ID, &user.Username, &user.FirstName, &user.LastName, &user.Role, &user.HasProfileIcon, &user.CreatedAt, &user.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUserNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to update role: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("failed to commit transaction: %w", err)
	}
	return &user, nil
}

// DeleteWithCleanup deletes a user and runs optional preDelete/postDelete
// callbacks inside the same transaction. preDelete executes before the user
// row is deleted, while it (and everything that cascades from it, e.g.
// note_images.uploader_id rows) is still there to read — callers that need to
// know what the cascade is about to remove must do that read here, since
// looking it up afterward would find nothing. postDelete executes after the
// user row is deleted (and cascade effects like note_shares removal have
// taken place) but before the transaction commits, so any cleanup is atomic
// with the delete.
func (s *userStore) DeleteWithCleanup(ctx context.Context, id, requestingUserID string, preDelete, postDelete func(ctx context.Context, tx *sql.Tx) error) error {
	if id == requestingUserID {
		return ErrCannotDeleteSelf
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var role string
	err = tx.QueryRowContext(ctx, s.d.RewritePlaceholders(`SELECT role FROM users WHERE id = ?`), id).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUserNotFound
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
			return ErrLastAdmin
		}
	}

	if preDelete != nil {
		if err = preDelete(ctx, tx); err != nil {
			return fmt.Errorf("pre-delete read failed: %w", err)
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
		return ErrUserNotFound
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
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), passwordHashCost)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	userID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate user ID: %w", err)
	}

	now := Timestamp(Now())
	query := `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
			  VALUES (?, ?, ?, ?, ?, ?) RETURNING created_at, updated_at`

	var user User
	err = s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(query), userID, username, string(hashedPassword), role, now, now).Scan(
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

// userSelectColumns is the column list every full-user SELECT shares, so the
// OIDC lookups scan identically to GetByID/GetByUsername.
const userSelectColumns = `id, username, first_name, last_name, COALESCE(password_hash, '') AS password_hash, role,
		         profile_icon IS NOT NULL AS has_profile_icon,
		         created_at, updated_at`

// GetByOIDCIdentity looks up the user bound to an (issuer, subject) pair.
// Returns ErrUserNotFound when no account is linked to that identity.
func (s *userStore) GetByOIDCIdentity(ctx context.Context, issuer, subject string) (*User, error) {
	var user User
	query := `SELECT ` + userSelectColumns + `
			  FROM users WHERE oidc_issuer = ? AND oidc_subject = ?`

	err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(query), issuer, subject).Scan(
		&user.ID, &user.Username, &user.FirstName, &user.LastName, &user.PasswordHash,
		&user.Role, &user.HasProfileIcon, &user.CreatedAt, &user.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("failed to get user by OIDC identity: %w", err)
	}
	return &user, nil
}

// ssoUsernameFallback is used when a derived candidate username cannot be
// sanitized into anything valid; the caller always passes a non-empty seed in
// practice (it falls back to the subject), so this only guards pathological
// claims.
const ssoUsernameFallback = "user"

// ProvisionSSOUser creates a new SSO-backed user for the (issuer, subject) pair.
// The username is seeded from usernameSeed, sanitized to satisfy the username
// rules, and de-duplicated on collision by appending -2, -3, … The account has
// a NULL password_hash (no local password). Role follows §6 of the OIDC spec:
// the first user is admin only when grantAdminIfFirst is set (SSO-only
// deployments, where local login is disabled), otherwise a plain user.
func (s *userStore) ProvisionSSOUser(ctx context.Context, issuer, subject, usernameSeed string, grantAdminIfFirst bool) (*User, error) {
	base := sanitizeUsername(usernameSeed)
	if base == "" {
		base = ssoUsernameFallback
	}

	userID, err := generateID()
	if err != nil {
		return nil, fmt.Errorf("failed to generate user ID: %w", err)
	}

	var count int
	if err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders("SELECT COUNT(*) FROM users")).Scan(&count); err != nil {
		return nil, fmt.Errorf("failed to count users: %w", err)
	}
	role := RoleUser
	if count == 0 && grantAdminIfFirst {
		role = RoleAdmin
	}

	now := Timestamp(Now())
	query := `INSERT INTO users (id, username, password_hash, role, oidc_issuer, oidc_subject, created_at, updated_at)
			  VALUES (?, ?, NULL, ?, ?, ?, ?, ?) RETURNING created_at, updated_at`

	// Try the bare candidate, then candidate-2, -3, … on username collision.
	// A collision on (oidc_issuer, oidc_subject) is not expected here — the
	// caller only provisions after GetByOIDCIdentity missed — but is surfaced
	// as ErrOIDCIdentityLinked rather than retried, since retrying would spin.
	const maxAttempts = 100
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		username := base
		if attempt > 1 {
			username = usernameWithSuffix(base, attempt)
		}

		var user User
		err := s.db.QueryRowContext(ctx, s.d.RewritePlaceholders(query),
			userID, username, role, issuer, subject, now, now).Scan(&user.CreatedAt, &user.UpdatedAt)
		if err == nil {
			user.ID = userID
			user.Username = username
			user.Role = role
			return &user, nil
		}
		if !s.d.IsUniqueConstraintError(err) {
			return nil, fmt.Errorf("failed to provision SSO user: %w", err)
		}
		// A unique violation is either the username (retry with a suffix) or the
		// OIDC identity (already linked — do not retry). Distinguish by checking
		// whether the identity now resolves to an existing user.
		if _, lookupErr := s.GetByOIDCIdentity(ctx, issuer, subject); lookupErr == nil {
			return nil, ErrOIDCIdentityLinked
		}
		// Otherwise it was a username collision; loop to try the next suffix.
	}
	return nil, fmt.Errorf("failed to provision SSO user: exhausted username candidates for %q", base)
}

// LinkOIDCIdentity binds an (issuer, subject) pair to an existing user. Returns
// ErrOIDCIdentityLinked if that pair already belongs to a different user (the
// unique index rejects it), and ErrUserNotFound if the user does not exist.
func (s *userStore) LinkOIDCIdentity(ctx context.Context, userID, issuer, subject string) error {
	result, err := s.db.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE users SET oidc_issuer = ?, oidc_subject = ?, updated_at = ? WHERE id = ?`),
		issuer, subject, Timestamp(Now()), userID,
	)
	if err != nil {
		if s.d.IsUniqueConstraintError(err) {
			return ErrOIDCIdentityLinked
		}
		return fmt.Errorf("failed to link OIDC identity: %w", err)
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

// UnlinkOIDCIdentity clears the OIDC identity columns for a user. It refuses to
// strand an account: a user whose password_hash is NULL has no other way to
// sign in, so unlinking is rejected with ErrWouldStrandAccount until they set a
// password. Returns ErrUserNotFound if the user does not exist.
func (s *userStore) UnlinkOIDCIdentity(ctx context.Context, userID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var passwordHash sql.Null[string]
	err = tx.QueryRowContext(ctx, s.d.RewritePlaceholders(`SELECT password_hash FROM users WHERE id = ?`), userID).Scan(&passwordHash)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUserNotFound
	}
	if err != nil {
		return fmt.Errorf("failed to read user for unlink: %w", err)
	}
	if !passwordHash.Valid || passwordHash.V == "" {
		return ErrWouldStrandAccount
	}

	if _, err := tx.ExecContext(ctx,
		s.d.RewritePlaceholders(`UPDATE users SET oidc_issuer = NULL, oidc_subject = NULL, updated_at = ? WHERE id = ?`),
		Timestamp(Now()), userID,
	); err != nil {
		return fmt.Errorf("failed to unlink OIDC identity: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}
	return nil
}

// ssoUsernameRegex mirrors the allowed username character set enforced by the
// handlers (validateUsername / usernameRegex). sanitizeUsername strips
// everything else so a claim can seed a valid username.
var ssoUsernameRegex = regexp.MustCompile(`[^a-z0-9_-]+`)

// maxUsernameLen mirrors the handlers' validateUsername upper bound (30 code
// points). Kept here so provisioned usernames — including their collision
// suffix — stay within the same limit the API enforces on user-supplied ones.
const maxUsernameLen = 30

// usernameWithSuffix appends a "-N" de-duplication suffix to base, truncating
// base first so the whole result stays within maxUsernameLen even for
// multi-digit N. The trailing '_'/'-' left by truncation is trimmed so the
// result never reads as "foo--2".
func usernameWithSuffix(base string, attempt int) string {
	suffix := fmt.Sprintf("-%d", attempt)
	if len(base)+len(suffix) > maxUsernameLen {
		base = strings.TrimRight(base[:maxUsernameLen-len(suffix)], "_-")
	}
	return base + suffix
}

// sanitizeUsername turns an arbitrary claim value into a candidate that
// satisfies the username rules: lower-cased, restricted to [a-z0-9_-], with no
// leading/trailing '_' or '-', clamped to the 2–30 character range. It returns
// "" when nothing valid remains, letting the caller fall back.
func sanitizeUsername(seed string) string {
	s := strings.ToLower(strings.TrimSpace(seed))
	s = ssoUsernameRegex.ReplaceAllString(s, "")
	s = strings.Trim(s, "_-")
	if len(s) > maxUsernameLen {
		s = strings.Trim(s[:maxUsernameLen], "_-")
	}
	if len(s) < 2 {
		return ""
	}
	return s
}
