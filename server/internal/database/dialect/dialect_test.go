package dialect_test

import (
	"errors"
	"testing"

	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/lib/pq"
	"github.com/stretchr/testify/assert"
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

func TestFullTextMatchExpr(t *testing.T) {
	t.Run("SQLite quotes terms, ANDs implicitly, prefixes the last", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "sqlite"}
		assert.Equal(t, `"foo"*`, d.FullTextMatchExpr([]string{"foo"}))
		assert.Equal(t, `"foo" "bar" "baz"*`, d.FullTextMatchExpr([]string{"foo", "bar", "baz"}))
	})

	t.Run("Postgres ANDs with & and prefixes the last with :*", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "postgres"}
		assert.Equal(t, "foo:*", d.FullTextMatchExpr([]string{"foo"}))
		assert.Equal(t, "foo & bar & baz:*", d.FullTextMatchExpr([]string{"foo", "bar", "baz"}))
	})
}

func TestFullTextSearchJoin(t *testing.T) {
	t.Run("SQLite matches note_search and ranks by bm25 ascending", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "sqlite"}
		join, order := d.FullTextSearchJoin()
		assert.Contains(t, join, "note_search MATCH ?")
		assert.Contains(t, join, "bm25(note_search)")
		assert.Equal(t, "sr.rank ASC", order)
	})

	t.Run("Postgres matches tsvector and ranks by ts_rank descending", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "postgres"}
		join, order := d.FullTextSearchJoin()
		assert.Contains(t, join, "to_tsquery('simple', ?)")
		assert.Contains(t, join, "search_tsv @@ q")
		assert.Equal(t, "sr.rank DESC", order)
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

	t.Run("PostgreSQL uses LOWER(col) = LOWER(?)", func(t *testing.T) {
		// Deliberately not ILIKE: ILIKE would interpret `%`/`_` in the bound
		// value as pattern wildcards, matching the wrong label.
		d := &dialect.Dialect{Driver: "postgres"}
		assert.Equal(t, "LOWER(name) = LOWER(?)", d.CaseInsensitiveEquals("name"))
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

func TestLabelNameConflictTarget(t *testing.T) {
	t.Run("SQLite infers the plain unique constraint, which is COLLATE NOCASE", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "sqlite"}
		assert.Equal(t, "(user_id, name)", d.LabelNameConflictTarget())
	})

	t.Run("Postgres infers the unique index on the LOWER(name) expression", func(t *testing.T) {
		d := &dialect.Dialect{Driver: "postgres"}
		assert.Equal(t, "(user_id, LOWER(name))", d.LabelNameConflictTarget())
	})
}
