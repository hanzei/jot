package cmd

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestVersionCmd(t *testing.T) {
	ts := setupTestServer(t)
	admin := ts.createAdmin(t, "admin", "adminpass")

	t.Run("text output", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "version")
		require.NoError(t, res.Err)
		assert.Contains(t, res.Stdout, "jotctl")
	})

	t.Run("json output", func(t *testing.T) {
		res := runJotCTL(t, ts, admin, "--json", "version")
		require.NoError(t, res.Err)

		var info versionInfo
		require.NoError(t, json.Unmarshal([]byte(res.Stdout), &info))
		assert.NotEmpty(t, info.GoVersion)
		assert.NotEmpty(t, info.Version)
	})
}
