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
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lib/pq"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// EnvPostgresDSN is the environment variable that points tests at a running
// PostgreSQL server, e.g. "postgres://user:pass@localhost:5432/postgres?sslmode=disable".
// When it's unset, postgres-backed tests fall back to a Postgres container
// started on demand via testcontainers-go (see containerBaseDSN), and skip
// (rather than fail) if Docker isn't available either, so `go test ./...`
// stays green with no setup required on a developer machine.
const EnvPostgresDSN = "TEST_POSTGRES_DSN"

// EnvDisableTestcontainers, when set to a non-empty value, disables the
// testcontainers-go fallback described above, restoring the plain "skip
// unless EnvPostgresDSN is set" behavior.
const EnvDisableTestcontainers = "TEST_POSTGRES_NO_TESTCONTAINERS"

// Drivers returns the database drivers store and migration tests should run
// against: always "sqlite", plus "postgres". Postgres subtests skip
// themselves at the point they need a real server if neither EnvPostgresDSN
// nor a working Docker daemon is available.
func Drivers() []string {
	return []string{"sqlite", "postgres"}
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
// server pointed to by EnvPostgresDSN, or a testcontainers-managed container
// if that's unset, and registers cleanup to drop it (skipping the test if
// neither is available); for sqlite it returns a path inside a fresh temp
// directory.
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

// container* hold the single Postgres testcontainer shared by every test in
// this binary, lazily started on first use. Tests never call Terminate on
// it: testcontainers-go's Ryuk reaper cleans it up once the test process
// exits, the same way a developer would `docker stop` a manually-started
// container.
var (
	containerOnce sync.Once
	containerDSN  string
	containerErr  error
)

// containerBaseDSN returns a base DSN for the shared Postgres testcontainer,
// starting it on first call. It skips t (rather than failing) if
// EnvDisableTestcontainers is set or Docker isn't available, mirroring the
// existing "no EnvPostgresDSN" skip behavior.
func containerBaseDSN(t *testing.T) string {
	t.Helper()

	if os.Getenv(EnvDisableTestcontainers) != "" {
		t.Skipf("%s set and %s not set; skipping postgres test", EnvDisableTestcontainers, EnvPostgresDSN)
	}
	testcontainers.SkipIfProviderIsNotHealthy(t)

	containerOnce.Do(func() {
		// t.Context() is only used for this synchronous startup call, which
		// completes well before t's cleanup phase (and context cancellation)
		// begins, even though the container it starts outlives t.
		ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
		defer cancel()

		container, err := tcpostgres.Run(ctx, "postgres:16-alpine",
			tcpostgres.WithDatabase("jot_test"),
			tcpostgres.WithUsername("jot"),
			tcpostgres.WithPassword("jot"),
			testcontainers.WithWaitStrategy(
				wait.ForListeningPort("5432/tcp").WithStartupTimeout(60*time.Second),
			),
		)
		if err != nil {
			containerErr = fmt.Errorf("start postgres testcontainer: %w", err)
			return
		}
		dsn, err := container.ConnectionString(ctx, "sslmode=disable")
		if err != nil {
			containerErr = fmt.Errorf("get postgres testcontainer connection string: %w", err)
			return
		}
		containerDSN = dsn
	})

	if containerErr != nil {
		t.Skipf("testcontainers: %v", containerErr)
	}
	return containerDSN
}

// isolatedPostgresDSN creates a fresh, empty database on the server pointed
// to by EnvPostgresDSN (or, absent that, a testcontainers-managed Postgres
// container, see containerBaseDSN) and returns a DSN for it, registering
// cleanup to drop it once the test finishes. Every test gets its own
// database rather than sharing one, since both a manually-provided
// TEST_POSTGRES_DSN and the shared container expose a single server.
func isolatedPostgresDSN(t *testing.T) string {
	t.Helper()

	baseDSN := os.Getenv(EnvPostgresDSN)
	if baseDSN == "" {
		baseDSN = containerBaseDSN(t)
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
