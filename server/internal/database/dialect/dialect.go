package dialect

import (
	"errors"
	"fmt"
	"strings"

	"github.com/lib/pq"
	sqlitedriver "modernc.org/sqlite"
)

const (
	// DriverPostgres is the driver name for PostgreSQL.
	DriverPostgres = "postgres"

	// sqliteUniqueConstraint is the SQLite extended error code for UNIQUE constraint violations.
	sqliteUniqueConstraint = 2067
)

// Dialect abstracts SQL differences between database drivers.
type Dialect struct {
	Driver string // "sqlite" | DriverPostgres
}

// RewritePlaceholders converts ? positional placeholders to $1, $2, ... for
// PostgreSQL. It is a no-op for SQLite.
func (d *Dialect) RewritePlaceholders(query string) string {
	if d.Driver != DriverPostgres {
		return query
	}
	var b strings.Builder
	n := 1
	for _, c := range query {
		if c == '?' {
			fmt.Fprintf(&b, "$%d", n)
			n++
		} else {
			b.WriteRune(c)
		}
	}
	return b.String()
}

// InsertIgnore returns a dialect-correct INSERT ... ON CONFLICT DO NOTHING statement.
// table is the table name, cols is the comma-separated column list, placeholders
// is the VALUES list using ? syntax (e.g. "?, ?, ?").
func (d *Dialect) InsertIgnore(table, cols, placeholders string) string {
	switch d.Driver {
	case DriverPostgres:
		return fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s) ON CONFLICT DO NOTHING", table, cols, placeholders)
	default: // sqlite
		return fmt.Sprintf("INSERT OR IGNORE INTO %s (%s) VALUES (%s)", table, cols, placeholders)
	}
}

// CaseInsensitiveEquals returns a dialect-correct case-insensitive equality
// expression for use in a WHERE clause. The returned string uses ? placeholder syntax.
// SQLite: LOWER(col) = LOWER(?)
// PostgreSQL: col ILIKE ?
func (d *Dialect) CaseInsensitiveEquals(col string) string {
	switch d.Driver {
	case DriverPostgres:
		return col + " ILIKE ?"
	default: // sqlite
		return fmt.Sprintf("LOWER(%s) = LOWER(?)", col)
	}
}

// IsUniqueConstraintError reports whether err is a unique-constraint violation
// from the configured driver.
func (d *Dialect) IsUniqueConstraintError(err error) bool {
	if err == nil {
		return false
	}
	switch d.Driver {
	case DriverPostgres:
		var pqErr *pq.Error
		return errors.As(err, &pqErr) && pqErr.Code == "23505"
	default: // sqlite
		var sqliteErr *sqlitedriver.Error
		return errors.As(err, &sqliteErr) && sqliteErr.Code() == sqliteUniqueConstraint
	}
}
