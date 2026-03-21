package main

import (
	"database/sql"
	"errors"
	"testing"
	"time"

	sqlite3 "github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSQLiteForeignKeysEnabledAfterStartup(t *testing.T) {
	ts := setupTestServer(t)
	db := ts.Server.GetDB()
	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(2)

	conn1, err := db.Conn(t.Context())
	require.NoError(t, err)
	defer func() { _ = conn1.Close() }()

	conn2, err := db.Conn(t.Context())
	require.NoError(t, err)
	defer func() { _ = conn2.Close() }()

	assertForeignKeysEnabledOnConn(t, conn1)
	assertForeignKeysEnabledOnConn(t, conn2)
}

func TestSQLiteRejectsInvalidForeignKeys(t *testing.T) {
	ts := setupTestServer(t)

	_, err := ts.Server.GetDB().Exec(
		`INSERT INTO sessions (token, user_id, expires_at, user_agent) VALUES (?, ?, ?, '')`,
		"orphan-session-token",
		"missing-user",
		time.Now().Add(time.Hour),
	)
	require.Error(t, err)

	var sqliteErr sqlite3.Error
	require.True(t, errors.As(err, &sqliteErr))
	assert.Equal(t, sqlite3.ErrConstraintForeignKey, sqliteErr.ExtendedCode)
}

func assertForeignKeysEnabledOnConn(t *testing.T, conn *sql.Conn) {
	t.Helper()

	var enabled int
	require.NoError(t, conn.QueryRowContext(t.Context(), "PRAGMA foreign_keys").Scan(&enabled))
	assert.Equal(t, 1, enabled)
}
