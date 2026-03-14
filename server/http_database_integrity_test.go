package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSQLiteForeignKeysAreEnabled(t *testing.T) {
	ts := setupTestServer(t)

	var enabled int
	err := ts.Server.GetDB().QueryRow(`PRAGMA foreign_keys`).Scan(&enabled)
	require.NoError(t, err)
	assert.Equal(t, 1, enabled)

	_, err = ts.Server.GetDB().Exec(
		`INSERT INTO notes (id, user_id, title, content, note_type, color, position, unpinned_position, checked_items_collapsed)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"noteforeignkeytestid001",
		"missinguserid000000001",
		"fk test",
		"",
		"text",
		"#ffffff",
		0,
		0,
		false,
	)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "FOREIGN KEY constraint failed")
}
