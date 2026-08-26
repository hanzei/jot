package models

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// timestampColumnsByTable lists, for every table this package inserts into, the
// timestamp columns whose value the store layer is responsible for supplying.
// Keep it in step with internal/database/migrations.
//
// The schema still carries DEFAULT CURRENT_TIMESTAMP on these columns as a
// backstop for rows written outside the store layer (data migrations), which is
// exactly what makes a forgotten column quiet: the insert succeeds and the
// database fills in a value of its own, at whatever precision that backend's
// CURRENT_TIMESTAMP happens to have. TestInsertsSupplyTimestampColumns turns
// that silence into a failing test.
var timestampColumnsByTable = map[string][]string{
	"labels":                 {"created_at", "updated_at"},
	"note_images":            {"created_at"},
	"note_items":             {"created_at", "updated_at"},
	"note_labels":            {"created_at"},
	"note_shares":            {"created_at", "updated_at"},
	"note_user_state":        {"created_at", "updated_at"},
	"notes":                  {"created_at", "updated_at"},
	"personal_access_tokens": {"created_at"},
	"sessions":               {"created_at"},
	"user_settings":          {"created_at", "updated_at"},
	"users":                  {"created_at", "updated_at"},
}

// insertRe matches the table and column list of an INSERT written out in full.
// Column lists never contain a nested paren, so the non-greedy run to the first
// ")" is the whole list.
var insertRe = regexp.MustCompile(`(?s)INSERT (?:OR IGNORE )?INTO\s+(\w+)\s*\(([^)]*)\)`)

// insertIgnoreRe matches the dialect helper, which takes its table and column
// list as separate string arguments rather than spelling out the statement.
var insertIgnoreRe = regexp.MustCompile(`InsertIgnore\("(\w+)",\s*"([^"]*)"`)

// TestInsertsSupplyTimestampColumns fails when an INSERT in this package omits
// a timestamp column, leaving the row to the schema default.
//
// Timestamps are generated in Go so that both backends store the same value at
// the same precision, and so that every row one operation writes carries one
// timestamp (see Timestamp). An insert that falls back to the default silently
// opts that table out of both guarantees — nothing errors, the column is simply
// filled by the database again. This test is the check that catches it, since
// no linter can.
func TestInsertsSupplyTimestampColumns(t *testing.T) {
	entries, err := os.ReadDir(".")
	require.NoError(t, err)

	checked := 0
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}

		source, readErr := os.ReadFile(filepath.Clean(name))
		require.NoError(t, readErr)

		for _, match := range insertMatches(string(source)) {
			required, tracked := timestampColumnsByTable[match.table]
			if !tracked {
				continue
			}
			checked++
			for _, column := range required {
				assert.Contains(t, match.columns, column,
					"%s: INSERT INTO %s omits %s, so the database default fills it in — "+
						"pass Timestamp(Now()) for it instead", name, match.table, column)
			}
		}
	}

	// Guards the guard: a regex that stopped matching would otherwise make this
	// test pass by checking nothing at all.
	assert.Greater(t, checked, 15, "found far fewer INSERTs than this package has")
}

type insertMatch struct {
	table   string
	columns []string
}

func insertMatches(source string) []insertMatch {
	var matches []insertMatch
	for _, re := range []*regexp.Regexp{insertRe, insertIgnoreRe} {
		for _, m := range re.FindAllStringSubmatch(source, -1) {
			columns := strings.Split(m[2], ",")
			for i, column := range columns {
				columns[i] = strings.TrimSpace(column)
			}
			matches = append(matches, insertMatch{table: m[1], columns: columns})
		}
	}
	return matches
}
