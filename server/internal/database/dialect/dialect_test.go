package dialect_test

import (
	"errors"
	"testing"

	"github.com/lib/pq"
	"github.com/stretchr/testify/assert"
	"github.com/hanzei/jot/server/internal/database/dialect"
)

func TestRewritePlaceholders(t *testing.T) {
	t.Run("no-op for SQLite", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "sqlite"}
		q := "SELECT * FROM notes WHERE id = ? AND user_id = ?"
		assert.Equal(t, q, d.RewritePlaceholders(q))
	})

	t.Run("rewrites ? to $N for PostgreSQL", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "postgres"}
		assert.Equal(t,
			"SELECT * FROM notes WHERE id = $1 AND user_id = $2",
			d.RewritePlaceholders("SELECT * FROM notes WHERE id = ? AND user_id = ?"),
		)
	})

	t.Run("single placeholder", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "postgres"}
		assert.Equal(t, "SELECT * FROM users WHERE id = $1",
			d.RewritePlaceholders("SELECT * FROM users WHERE id = ?"))
	})

	t.Run("no placeholder is unchanged", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "postgres"}
		q := "SELECT 1"
		assert.Equal(t, q, d.RewritePlaceholders(q))
	})
}

func TestInsertIgnore(t *testing.T) {
	t.Run("SQLite uses INSERT OR IGNORE", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "sqlite"}
		assert.Equal(t,
			"INSERT OR IGNORE INTO t (a, b) VALUES (?, ?)",
			d.InsertIgnore("t", "a, b", "?, ?"),
		)
	})

	t.Run("PostgreSQL uses ON CONFLICT DO NOTHING", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "postgres"}
		assert.Equal(t,
			"INSERT INTO t (a, b) VALUES (?, ?) ON CONFLICT DO NOTHING",
			d.InsertIgnore("t", "a, b", "?, ?"),
		)
	})
}

func TestCaseInsensitiveEquals(t *testing.T) {
	t.Run("SQLite uses LOWER(col) = LOWER(?)", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "sqlite"}
		assert.Equal(t, "LOWER(name) = LOWER(?)", d.CaseInsensitiveEquals("name"))
	})

	t.Run("PostgreSQL uses ILIKE", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "postgres"}
		assert.Equal(t, "name ILIKE ?", d.CaseInsensitiveEquals("name"))
	})
}

func TestLimitAll(t *testing.T) {
	t.Run("SQLite returns -1", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "sqlite"}
		assert.Equal(t, "-1", d.LimitAll())
	})

	t.Run("PostgreSQL returns ALL", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "postgres"}
		assert.Equal(t, "ALL", d.LimitAll())
	})
}

func TestIsUniqueConstraintError(t *testing.T) {
	t.Run("PostgreSQL 23505 returns true", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "postgres"}
		pqErr := &pq.Error{Code: "23505"}
		assert.True(t, d.IsUniqueConstraintError(pqErr))
	})

	t.Run("PostgreSQL non-unique error returns false", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "postgres"}
		pqErr := &pq.Error{Code: "23503"} // FK violation
		assert.False(t, d.IsUniqueConstraintError(pqErr))
	})

	t.Run("generic error returns false", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "sqlite"}
		assert.False(t, d.IsUniqueConstraintError(errors.New("some error")))
	})

	t.Run("nil error returns false", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "sqlite"}
		assert.False(t, d.IsUniqueConstraintError(nil))
	})
}
