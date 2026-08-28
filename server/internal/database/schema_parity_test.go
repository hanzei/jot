package database

import (
	"database/sql"
	"testing"
	"time"

	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/hanzei/jot/server/internal/database/dsntest"
	"github.com/hanzei/jot/server/internal/labelfold"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newMigratedDB opens a fresh, fully migrated database for driver. It is the
// same thing dbtest.New does, spelled out here because dbtest imports this
// package and cannot be imported back from its own tests.
func newMigratedDB(t *testing.T, driver string) *sql.DB {
	t.Helper()

	db, err := New(driver, dsntest.IsolatedDSN(t, driver))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// TestSchemaParity pins the invariants SQLite and PostgreSQL must enforce
// identically. Both are asserted through behavior rather than by inspecting
// catalog tables, so the test says the same thing on either backend.
func TestSchemaParity(t *testing.T) {
	dsntest.ForEachDriver(t, func(t *testing.T, driver string) {
		db := newMigratedDB(t, driver)
		d := &dialect.Dialect{Driver: driver}
		ctx := t.Context()

		_, err := db.ExecContext(ctx, d.RewritePlaceholders(
			`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`),
			"user000000000000parity", "parity", "x")
		require.NoError(t, err)

		t.Run("note_type is not constrained by the database", func(t *testing.T) {
			// Allowed values are validated in the application layer. Neither
			// backend may add a CHECK, or data written on one could fail to
			// replicate to the other.
			_, err := db.ExecContext(ctx, d.RewritePlaceholders(
				`INSERT INTO notes (id, user_id, note_type) VALUES (?, ?, ?)`),
				"note000000000000parity", "user000000000000parity", "not-a-note-type")
			assert.NoError(t, err)
		})

		// insertLabel writes a label the way the stores do, with name_folded
		// carrying labelfold.Fold(name). Going through raw SQL here is the
		// point: it asserts what the schema enforces, not what the store
		// remembers to do.
		insertLabel := func(id, userID, name string) error {
			_, err := db.ExecContext(ctx, d.RewritePlaceholders(
				`INSERT INTO labels (id, user_id, name, name_folded) VALUES (?, ?, ?, ?)`),
				id, userID, name, labelfold.Fold(name))
			return err
		}

		t.Run("label names are unique per user case-insensitively", func(t *testing.T) {
			require.NoError(t, insertLabel("labl00000000000000work", "user000000000000parity", "Work"))

			err := insertLabel("labl00000000000000wrk2", "user000000000000parity", "work")
			require.Error(t, err)
			assert.True(t, d.IsUniqueConstraintError(err), "want a unique violation, got %v", err)
		})

		t.Run("label names differing only in non-ASCII case collide", func(t *testing.T) {
			// Both backends fold through labelfold.Fold, so the reach is
			// Unicode-wide and identical on each. This is the inverse of what
			// the schema enforced before #773: the fold used to be ASCII A-Z
			// only, because that was all SQLite's LOWER() could do, and these
			// two rows could both exist.
			for _, tt := range []struct{ name, a, b, idA, idB string }{
				{"german umlaut", "ÄPFEL", "äpfel", "labl000000000000upperÄ", "labl000000000000lowerä"},
				{"german sharp s", "Straße", "STRASSE", "labl00000000000sharps1", "labl00000000000sharps2"},
				{"greek final sigma", "ΣΟΦΟΣ", "σοφος", "labl00000000000sigma01", "labl00000000000sigma02"},
			} {
				t.Run(tt.name, func(t *testing.T) {
					require.NoError(t, insertLabel(tt.idA, "user000000000000parity", tt.a))

					err := insertLabel(tt.idB, "user000000000000parity", tt.b)
					require.Error(t, err, "%q must collide with %q", tt.b, tt.a)
					assert.True(t, d.IsUniqueConstraintError(err), "want a unique violation, got %v", err)
				})
			}
		})

		t.Run("accents are folded for case but not stripped", func(t *testing.T) {
			// "Apfel" and "Äpfel" are different words, not case variants of one.
			require.NoError(t, insertLabel("labl0000000000noumlaut", "user000000000000parity", "Apfel"))
		})

		t.Run("label names may repeat across users", func(t *testing.T) {
			_, err := db.ExecContext(ctx, d.RewritePlaceholders(
				`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`),
				"user00000000000parity2", "parity2", "x")
			require.NoError(t, err)

			assert.NoError(t, insertLabel("labl0000000000000work2", "user00000000000parity2", "work"))
		})
	})
}

// TestDatabaseTimestampsAreUTC covers the PostgreSQL half of the timestamp
// story: timestamp columns are TIMESTAMP WITHOUT TIME ZONE, so a DB-side
// default resolved in a non-UTC session would silently store local wall clock.
// Pinning every session to UTC keeps those defaults comparable with the UTC
// times the application generates. SQLite has no session time zone, so there is
// nothing to assert for it.
func TestDatabaseTimestampsAreUTC(t *testing.T) {
	db, err := New(driverPostgres, dsntest.IsolatedDSNInTimeZone(t, driverPostgres, "America/New_York"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	ctx := t.Context()

	var tz string
	require.NoError(t, db.QueryRowContext(ctx, `SHOW TimeZone`).Scan(&tz))
	assert.Equal(t, "UTC", tz, "sessions must be pinned to UTC regardless of the database's own time zone")

	before := time.Now().UTC()
	_, err = db.ExecContext(ctx, `INSERT INTO users (id, username, password_hash) VALUES ('user0000000000000000tz', 'tz', 'x')`)
	require.NoError(t, err)

	// created_at comes from DEFAULT CURRENT_TIMESTAMP. lib/pq reads a naive
	// timestamp back as UTC, so a session left on America/New_York would show
	// up here as several hours in the past.
	var createdAt time.Time
	require.NoError(t, db.QueryRowContext(ctx,
		`SELECT created_at FROM users WHERE id = 'user0000000000000000tz'`).Scan(&createdAt))

	assert.WithinRange(t, createdAt, before.Add(-time.Minute), time.Now().UTC().Add(time.Minute))
}
