// Package dbtest provides a fully migrated database test harness that runs
// store tests against SQLite unconditionally, and against a real PostgreSQL
// server when one is available (see dsntest.EnvPostgresDSN). It exists so
// backend divergence (dialect-specific SQL, unique-constraint error mapping)
// gets exercised in CI rather than only ever running against SQLite.
package dbtest

import (
	"database/sql"
	"testing"

	"github.com/hanzei/jot/server/internal/database"
	"github.com/hanzei/jot/server/internal/database/dsntest"
	"github.com/stretchr/testify/require"
)

// EnvPostgresDSN is the environment variable that points tests at a running
// PostgreSQL server. Postgres-backed tests skip (rather than fail) when it's
// unset, so `go test ./...` stays green with no setup required on a
// developer machine.
const EnvPostgresDSN = dsntest.EnvPostgresDSN

// Drivers returns the database drivers store tests should run against:
// always "sqlite", plus "postgres" when EnvPostgresDSN is set.
func Drivers() []string {
	return dsntest.Drivers()
}

// ForEachDriver runs fn once per driver returned by Drivers, as a subtest
// named after the driver.
func ForEachDriver(t *testing.T, fn func(t *testing.T, driver string)) {
	dsntest.ForEachDriver(t, fn)
}

// New opens a fresh, fully migrated database for driver, isolated from every
// other test. It registers cleanup to close (and for postgres, drop) the
// database, and skips the test if driver is "postgres" and EnvPostgresDSN is
// unset.
func New(t *testing.T, driver string) *sql.DB {
	t.Helper()

	db, err := database.New(driver, dsntest.IsolatedDSN(t, driver))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	return db
}
