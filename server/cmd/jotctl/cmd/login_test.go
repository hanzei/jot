package cmd

import (
	"bytes"
	"os"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoginCmd(t *testing.T) {
	ts := setupTestServer(t)
	c := client.New(ts.httpServer.URL)
	_, err := c.Register(t.Context(), "logintest", "loginpass")
	require.NoError(t, err)

	t.Run("writes session file", func(t *testing.T) {
		t.Setenv("JOTCTL_CONFIG_DIR", t.TempDir())

		var buf bytes.Buffer
		app := NewApp(&buf)
		root := app.newRootCmd()
		root.SetArgs([]string{
			"login",
			"--server", ts.httpServer.URL,
			"--username", "logintest",
			"--password", "loginpass",
		})
		require.NoError(t, root.Execute())

		assert.Contains(t, buf.String(), "Logged in as logintest")

		// Session file should exist, be readable, and contain the server URL.
		sf, err := readSessionFile()
		require.NoError(t, err)
		assert.Equal(t, ts.httpServer.URL, sf.Server)
		assert.NotEmpty(t, sf.SessionToken)
	})

	t.Run("fails with wrong password", func(t *testing.T) {
		t.Setenv("JOTCTL_CONFIG_DIR", t.TempDir())

		var buf bytes.Buffer
		root := NewApp(&buf).newRootCmd()
		root.SetArgs([]string{
			"login",
			"--server", ts.httpServer.URL,
			"--username", "logintest",
			"--password", "wrongpass",
		})
		require.Error(t, root.Execute())
	})
}

func TestLogoutCmd(t *testing.T) {
	ts := setupTestServer(t)
	admin := ts.createAdmin(t, "admin", "adminpass")

	res := runJotCTL(t, ts, admin, "logout")
	require.NoError(t, res.Err)
	assert.Contains(t, res.Stdout, "Logged out.")

	// Session file should be gone — JOTCTL_CONFIG_DIR still points to the dir
	// that runJotCTL set, so readSessionFile looks in the right place.
	_, err := readSessionFile()
	assert.ErrorIs(t, err, os.ErrNotExist)
}
