package database

import (
	"fmt"
	"io/fs"
	"testing"

	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/hanzei/jot/server/internal/database/dsntest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestNewRefusesNewerSchema covers starting an older build on a database a
// newer one has already migrated: New must refuse with a SchemaNewerError
// naming both versions, rather than golang-migrate's "read down for version
// N", and must leave the database as it found it.
func TestNewRefusesNewerSchema(t *testing.T) {
	t.Parallel()

	dsntest.ForEachDriver(t, func(t *testing.T, driver string) {
		for _, dirty := range []bool{false, true} {
			t.Run(fmt.Sprintf("dirty=%v", dirty), func(t *testing.T) {
				dsn := dsntest.IsolatedDSN(t, driver)
				d := &dialect.Dialect{Driver: driver}
				ctx := t.Context()

				db, err := New(driver, dsn)
				require.NoError(t, err)
				latest := latestEmbeddedVersion(t, driver)
				// What a build one migration ahead leaves behind.
				_, err = db.ExecContext(ctx, d.RewritePlaceholders(`UPDATE schema_migrations SET version = ?, dirty = ?`), latest+1, dirty)
				require.NoError(t, err)
				require.NoError(t, db.Close())

				_, err = New(driver, dsn)
				var newer *SchemaNewerError
				require.ErrorAs(t, err, &newer)
				assert.Equal(t, latest+1, newer.DBVersion)
				assert.Equal(t, latest, newer.LatestVersion)
				assert.Contains(t, err.Error(), fmt.Sprintf("version %d", latest+1))
				assert.Contains(t, err.Error(), "backup")

				raw, err := open(driver, dsn)
				require.NoError(t, err)
				t.Cleanup(func() { _ = raw.Close() })
				var (
					version  uint
					gotDirty bool
				)
				require.NoError(t, raw.QueryRowContext(ctx, `SELECT version, dirty FROM schema_migrations`).Scan(&version, &gotDirty))
				assert.Equal(t, latest+1, version, "the recorded version must be left alone")
				assert.Equal(t, dirty, gotDirty)
			})
		}
	})
}

// TestNewAcceptsCurrentSchema makes sure the check does not trip on an
// up-to-date database: reopening one New fully migrated must succeed.
func TestNewAcceptsCurrentSchema(t *testing.T) {
	t.Parallel()

	dsntest.ForEachDriver(t, func(t *testing.T, driver string) {
		dsn := dsntest.IsolatedDSN(t, driver)
		db, err := New(driver, dsn)
		require.NoError(t, err)
		require.NoError(t, db.Close())

		db, err = New(driver, dsn)
		require.NoError(t, err)
		require.NoError(t, db.Close())
	})
}

// latestEmbeddedVersion returns the newest migration embedded for driver,
// via latestMigrationVersion, after checking it against the highest number
// among the embedded file names.
func latestEmbeddedVersion(t *testing.T, driver string) uint {
	t.Helper()
	fsys, dir := sqliteMigrationsFS, "migrations/sqlite"
	if driver == driverPostgres {
		fsys, dir = postgresMigrationsFS, "migrations/postgres"
	}

	entries, err := fs.ReadDir(fsys, dir)
	require.NoError(t, err)
	var want uint
	for _, e := range entries {
		var v uint
		_, scanErr := fmt.Sscanf(e.Name(), "%d_", &v)
		require.NoError(t, scanErr, e.Name())
		want = max(want, v)
	}

	src, err := iofs.New(fsys, dir)
	require.NoError(t, err)
	latest, err := latestMigrationVersion(src)
	require.NoError(t, err)
	require.Equal(t, want, latest)
	return latest
}
