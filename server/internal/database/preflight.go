package database

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// usernameFoldMigrationVersion is the migration that folds users.username to
// lower case. Databases already at or past it cannot hold a collision, so the
// check below is skipped for them.
const usernameFoldMigrationVersion = 10

// checkUsernameCollisions reports an actionable error when two accounts differ
// only by the case of their username.
//
// Migration 000010 folds users.username to lower case. On a database created
// before usernames were restricted to [a-z0-9_-], "Ben" and "ben" may both
// exist; folding them would violate the UNIQUE index on users.username, so the
// migration aborts. That is the safe outcome — no account is silently renamed
// or merged — but golang-migrate surfaces it as a bare constraint violation
// naming neither the table nor the accounts involved. Running the same check
// first lets startup fail with something an operator can act on.
//
// LOWER() is safe to compare across backends here: the pre-000010 username
// character set was [a-zA-Z0-9_-], so every stored value is ASCII and
// PostgreSQL's locale-aware LOWER() agrees with SQLite's ASCII-only one.
func checkUsernameCollisions(ctx context.Context, db *sql.DB) error {
	query := `SELECT LOWER(username) AS folded, COUNT(*) AS n
	          FROM users
	          GROUP BY LOWER(username)
	          HAVING COUNT(*) > 1
	          ORDER BY LOWER(username)`

	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return fmt.Errorf("check username collisions: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var collisions []string
	for rows.Next() {
		var (
			folded string
			n      int
		)
		if err := rows.Scan(&folded, &n); err != nil {
			return fmt.Errorf("scan username collision: %w", err)
		}
		collisions = append(collisions, fmt.Sprintf("%q (%d accounts)", folded, n))
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate username collisions: %w", err)
	}

	if len(collisions) == 0 {
		return nil
	}

	return fmt.Errorf(
		"usernames are case-insensitive as of migration 000010, but these differ only by case and cannot be folded: %s. "+
			"Keep one account per group and rename or remove the others (change a username from the app's profile "+
			"settings, or drop an account with `jotctl users delete <id>`), then restart",
		strings.Join(collisions, ", "),
	)
}
