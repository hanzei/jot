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
// expression for use in a WHERE clause. The returned string uses ? placeholder
// syntax. Both dialects use LOWER(col) = LOWER(?) so the bound value is compared
// as a literal — deliberately not ILIKE, whose `%`/`_` would be interpreted as
// pattern wildcards (e.g. a label named "in_progress" would match "inXprogress").
func (d *Dialect) CaseInsensitiveEquals(col string) string {
	return fmt.Sprintf("LOWER(%s) = LOWER(?)", col)
}

// LabelNameConflictTarget returns the ON CONFLICT inference clause that matches
// the case-insensitive unique index on label names. Both backends enforce
// per-user case-insensitive uniqueness, but by different means: SQLite's
// labels.name is COLLATE NOCASE, so the plain UNIQUE(user_id, name) constraint
// already is case-insensitive, while PostgreSQL uses a unique index on the
// LOWER(name) expression, which ON CONFLICT can only infer if it is spelled out.
func (d *Dialect) LabelNameConflictTarget() string {
	if d.Driver == DriverPostgres {
		return "(user_id, LOWER(name))"
	}
	return "(user_id, name)"
}

// LimitAll returns the dialect-correct expression for "no upper bound" in a
// LIMIT clause. Use it as: "LIMIT " + d.LimitAll() + " OFFSET ?".
// SQLite uses -1; PostgreSQL uses ALL.
func (d *Dialect) LimitAll() string {
	if d.Driver == DriverPostgres {
		return "ALL"
	}
	return "-1"
}

// FullTextMatchExpr builds the backend-specific match expression bound into the
// full-text search query, from tokens already normalized by the caller (lower
// cased, split into literal alphanumeric words). Terms are ANDed and the final
// term is a prefix match, so search-as-you-type finds notes before the last
// word is fully typed. Because tokens contain no query operators, the result
// can never inject FTS/tsquery syntax. tokens must be non-empty.
func (d *Dialect) FullTextMatchExpr(tokens []string) string {
	switch d.Driver {
	case DriverPostgres:
		// tsquery: "foo & bar & baz:*" — ':*' prefix-matches the last lexeme.
		expr := strings.Join(tokens, " & ")
		return expr + ":*"
	default: // sqlite
		// FTS5: `"foo" "bar" "baz"*` — space is implicit AND; each term is
		// double-quoted (a string literal, so FTS5 keywords like AND/OR/NEAR are
		// never interpreted), and a trailing '*' on the last term is a prefix.
		quoted := make([]string, len(tokens))
		for i, tok := range tokens {
			quoted[i] = `"` + tok + `"`
		}
		return strings.Join(quoted, " ") + "*"
	}
}

// FullTextSearchJoin returns an INNER JOIN clause (aliased "sr") that selects
// the note IDs matching the full-text query along with a per-note relevance
// score, plus the ORDER BY fragment that sorts by that score (best first). The
// clause contains a single ? placeholder to bind the FullTextMatchExpr value.
// It is joined against the main query's note alias "n" on sr.note_id = n.id.
func (d *Dialect) FullTextSearchJoin() (join string, rankOrder string) {
	switch d.Driver {
	case DriverPostgres:
		// ts_rank: higher is more relevant, so order DESC.
		join = ` INNER JOIN (
			SELECT ns.note_id AS note_id, ts_rank(ns.search_tsv, q) AS rank
			FROM note_search ns, to_tsquery('simple', ?) q
			WHERE ns.search_tsv @@ q
		) sr ON sr.note_id = n.id`
		return join, "sr.rank DESC"
	default: // sqlite
		// bm25: lower (more negative) is more relevant, so order ASC.
		join = ` INNER JOIN (
			SELECT note_id, bm25(note_search) AS rank
			FROM note_search
			WHERE note_search MATCH ?
		) sr ON sr.note_id = n.id`
		return join, "sr.rank ASC"
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
		pqErr, ok := errors.AsType[*pq.Error](err)
		return ok && pqErr.Code == "23505"
	default: // sqlite
		sqliteErr, ok := errors.AsType[*sqlitedriver.Error](err)
		return ok && sqliteErr.Code() == sqliteUniqueConstraint
	}
}
