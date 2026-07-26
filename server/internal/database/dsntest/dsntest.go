// Package dsntest hands out isolated, per-test database connections for
// SQLite and (when available) PostgreSQL, without running migrations. It is
// deliberately dependency-free with respect to internal/database, so that
// package's own internal test files can use it too — a helper that imports
// internal/database back would create an import cycle for tests declared in
// "package database" itself.
//
// Most tests want a fully migrated database instead: see internal/database/dbtest.
package dsntest

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/lib/pq"
	"github.com/stretchr/testify/require"
)

// EnvPostgresDSN is the environment variable that points tests at a running
// PostgreSQL server, e.g. "postgres://user:pass@localhost:5432/postgres?sslmode=disable".
// Postgres-backed tests skip (rather than fail) when it's unset, so `go test
// ./...` stays green with no setup required on a developer machine.
const EnvPostgresDSN = "TEST_POSTGRES_DSN"

// Drivers returns the database drivers store and migration tests should run
// against: always "sqlite", plus "postgres" when EnvPostgresDSN is set.
func Drivers() []string {
	drivers := []string{"sqlite"}
	if os.Getenv(EnvPostgresDSN) != "" {
		drivers = append(drivers, "postgres")
	}
	return drivers
}

// ForEachDriver runs fn once per driver returned by Drivers, as a subtest
// named after the driver.
func ForEachDriver(t *testing.T, fn func(t *testing.T, driver string)) {
	t.Helper()
	for _, driver := range Drivers() {
		t.Run(driver, func(t *testing.T) { fn(t, driver) })
	}
}

// IsolatedDSN returns a DSN for a fresh, empty database for driver, isolated
// from every other test. For postgres it creates a new database on the
// server pointed to by EnvPostgresDSN and registers cleanup to drop it
// (skipping the test if EnvPostgresDSN is unset); for sqlite it returns a
// path inside a fresh temp directory.
func IsolatedDSN(t *testing.T, driver string) string {
	t.Helper()

	switch driver {
	case "sqlite":
		return t.TempDir() + "/test.db"
	case "postgres":
		return isolatedPostgresDSN(t)
	default:
		t.Fatalf("dsntest: unsupported driver %q", driver)
		return ""
	}
}

// IsolatedDSNInTimeZone is IsolatedDSN, except that for postgres the new
// database's default TimeZone is set to tz, so any session that does not pin
// its own time zone inherits it. Use it to prove behavior does not depend on
// the server's time zone. SQLite has no session time zone — its
// CURRENT_TIMESTAMP is always UTC — so tz is ignored there.
func IsolatedDSNInTimeZone(t *testing.T, driver, tz string) string {
	t.Helper()

	dsn := IsolatedDSN(t, driver)
	if driver != "postgres" {
		return dsn
	}

	u, err := url.Parse(dsn)
	require.NoError(t, err)

	admin, err := sql.Open("postgres", os.Getenv(EnvPostgresDSN))
	require.NoError(t, err)
	defer func() { _ = admin.Close() }()

	// #nosec G201 -- both the database name and tz are quoted by pq, and the
	// name is a generated identifier rather than user input
	_, err = admin.ExecContext(t.Context(), fmt.Sprintf("ALTER DATABASE %s SET TimeZone TO %s",
		pq.QuoteIdentifier(strings.TrimPrefix(u.Path, "/")), pq.QuoteLiteral(tz)))
	require.NoError(t, err)

	return dsn
}

// RawDB opens a fresh, isolated database for driver with no migrations
// applied, using the same connection settings database.New would.
func RawDB(t *testing.T, driver string) *sql.DB {
	t.Helper()

	db, err := sql.Open(driver, IsolatedDSN(t, driver))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	require.NoError(t, db.PingContext(t.Context()))

	if driver == "sqlite" {
		// Serialize access like production so modernc.org/sqlite doesn't deadlock.
		db.SetMaxOpenConns(1)
		_, err = db.ExecContext(t.Context(), `PRAGMA foreign_keys = ON`)
		require.NoError(t, err)
	}
	return db
}

// pgSeq disambiguates concurrently-created per-test databases on the same
// Postgres server within this test binary.
var pgSeq atomic.Uint64

// isolatedPostgresDSN creates a fresh, empty database on the server pointed
// to by EnvPostgresDSN and returns a DSN for it, registering cleanup to drop
// it once the test finishes. Every test gets its own database rather than
// sharing one, since TEST_POSTGRES_DSN points at a single shared server.
func isolatedPostgresDSN(t *testing.T) string {
	t.Helper()

	baseDSN := os.Getenv(EnvPostgresDSN)
	if baseDSN == "" {
		t.Skipf("%s not set; skipping postgres test", EnvPostgresDSN)
	}

	admin, err := sql.Open("postgres", baseDSN)
	require.NoError(t, err)
	defer func() { _ = admin.Close() }()

	name := fmt.Sprintf("jot_test_%d_%d", os.Getpid(), pgSeq.Add(1))
	// #nosec G201 -- name is a generated identifier, quoted via pq.QuoteIdentifier, not user input
	_, err = admin.ExecContext(t.Context(), fmt.Sprintf("CREATE DATABASE %s", pq.QuoteIdentifier(name)))
	require.NoError(t, err)
	t.Cleanup(func() {
		cleanup, openErr := sql.Open("postgres", baseDSN)
		if openErr != nil {
			return
		}
		defer func() { _ = cleanup.Close() }()
		// t.Context() is already canceled by the time Cleanup funcs run, so this
		// uses context.Background() instead.
		// #nosec G201 -- name is a generated identifier, quoted via pq.QuoteIdentifier, not user input
		_, _ = cleanup.ExecContext(context.Background(), fmt.Sprintf("DROP DATABASE IF EXISTS %s", pq.QuoteIdentifier(name)))
	})

	u, err := url.Parse(baseDSN)
	require.NoError(t, err)
	u.Path = "/" + name
	return u.String()
}
