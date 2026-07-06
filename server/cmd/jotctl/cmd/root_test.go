package cmd

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRootCmdErrorReporting(t *testing.T) {
	t.Run("runtime error surfaces instead of usage", func(t *testing.T) {
		// Point the session file at an empty directory so loadSession fails.
		t.Setenv("JOTCTL_CONFIG_DIR", t.TempDir())

		var out, errOut bytes.Buffer
		app := NewApp(&out)
		root := app.newRootCmd()
		root.SetOut(&out)
		root.SetErr(&errOut)
		root.SetArgs([]string{"users", "list"})

		err := root.Execute()
		require.EqualError(t, err, "not logged in — run 'jotctl login' first")
		require.NotContains(t, out.String(), "Usage:")
		require.NotContains(t, errOut.String(), "Usage:")
	})

	t.Run("flag parse error surfaces instead of usage", func(t *testing.T) {
		t.Setenv("JOTCTL_CONFIG_DIR", t.TempDir())

		var out, errOut bytes.Buffer
		app := NewApp(&out)
		root := app.newRootCmd()
		root.SetOut(&out)
		root.SetErr(&errOut)
		root.SetArgs([]string{"users", "list", "--bogus"})

		err := root.Execute()
		require.ErrorContains(t, err, "unknown flag: --bogus")
		require.NotContains(t, out.String(), "Usage:")
		require.NotContains(t, errOut.String(), "Usage:")
	})
}
