package models

import (
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/hanzei/jot/server/internal/database/dbtest"
	"github.com/hanzei/jot/server/internal/database/dialect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// latestMigrationVersion is the highest migration number in driver's tree,
// which is what a freshly migrated database must report.
func latestMigrationVersion(t *testing.T, driver string) int64 {
	t.Helper()

	entries, err := os.ReadDir("../database/migrations/" + driver)
	require.NoError(t, err)
	var latest int64
	for _, entry := range entries {
		prefix, _, ok := strings.Cut(entry.Name(), "_")
		require.True(t, ok, entry.Name())
		v, err := strconv.ParseInt(prefix, 10, 64)
		require.NoError(t, err)
		latest = max(latest, v)
	}
	return latest
}

func TestAdminStatsRuntime(t *testing.T) {
	dbtest.ForEachDriver(t, func(t *testing.T, driver string) {
		db := dbtest.New(t, driver)
		d := &dialect.Dialect{Driver: driver}
		ctx := t.Context()

		user, err := newUserStore(db, d).Create(ctx, "statsuser", "password123")
		require.NoError(t, err)
		sessions, err := newSessionStore(db, d)
		require.NoError(t, err)
		for range 2 {
			_, _, err = sessions.Create(ctx, user.ID, "test")
			require.NoError(t, err)
		}
		expired, _, err := sessions.Create(ctx, user.ID, "test")
		require.NoError(t, err)
		_, err = db.ExecContext(ctx, d.RewritePlaceholders(`UPDATE sessions SET expires_at = ? WHERE token_hash = ?`),
			Timestamp(Now().Add(-time.Minute)), expired.TokenHash)
		require.NoError(t, err)

		stats, err := newAdminStatsStore(db, d).GetStats(ctx)
		require.NoError(t, err)

		assert.Equal(t, driver, stats.Runtime.DatabaseBackend)
		assert.Equal(t, latestMigrationVersion(t, driver), stats.Runtime.MigrationVersion)
		assert.False(t, stats.Runtime.MigrationDirty)
		assert.Equal(t, int64(2), stats.Runtime.ActiveSessions, "expired sessions are not active")

		assert.Positive(t, stats.Storage.DatabaseSizeBytes)
	})
}
