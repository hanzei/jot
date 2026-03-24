package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"text/tabwriter"

	"github.com/hanzei/jot/server/client"
	"github.com/spf13/cobra"
)

const sessionCookieName = "jot_session"

var (
	jsonOutput bool
	jotClient  *client.Client
)

var rootCmd = &cobra.Command{
	Use:   "jotctl",
	Short: "Jot admin CLI",
	Long:  "jotctl manages users on a Jot server.\n\nRun 'jotctl login' first to authenticate.",
	PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
		return loadSession(cmd)
	},
}

// Execute runs the root command.
func Execute() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func init() {
	rootCmd.PersistentFlags().BoolVar(&jsonOutput, "json", false, "Output as JSON")
	rootCmd.AddCommand(loginCmd)
	rootCmd.AddCommand(logoutCmd)
	rootCmd.AddCommand(usersCmd)
}

func loadSession(_ *cobra.Command) error {
	sf, err := readSessionFile()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("not logged in — run 'jotctl login' first")
		}
		return fmt.Errorf("load session: %w", err)
	}

	jotClient = client.New(sf.Server)

	u, err := url.Parse(sf.Server)
	if err != nil {
		return fmt.Errorf("invalid server URL in session file: %w", err)
	}

	jotClient.HTTPClient().Jar.SetCookies(u, []*http.Cookie{
		{Name: sessionCookieName, Value: sf.SessionToken},
	})

	return nil
}

// sessionData is persisted to disk by the login command.
type sessionData struct {
	Server       string `json:"server"`
	SessionToken string `json:"session_token"`
}

func sessionFilePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("get config dir: %w", err)
	}
	return filepath.Join(dir, "jotctl", "session"), nil
}

func readSessionFile() (*sessionData, error) {
	path, err := sessionFilePath()
	if err != nil {
		return nil, err
	}

	//nolint:gosec // path is rooted at os.UserConfigDir() with a fixed subpath
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read session file: %w", err)
	}

	var sd sessionData
	if err := json.Unmarshal(data, &sd); err != nil {
		return nil, fmt.Errorf("parse session file: %w", err)
	}

	return &sd, nil
}

func writeSessionFile(sd *sessionData) error {
	path, err := sessionFilePath()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}

	data, err := json.Marshal(sd)
	if err != nil {
		return fmt.Errorf("marshal session: %w", err)
	}

	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write session file: %w", err)
	}

	return nil
}

func deleteSessionFile() error {
	path, err := sessionFilePath()
	if err != nil {
		return err
	}

	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove session file: %w", err)
	}

	return nil
}

// tableWriter wraps tabwriter and accumulates the first write error so callers
// can check only once via flush().
type tableWriter struct {
	tw  *tabwriter.Writer
	err error
}

func newTableWriter(w io.Writer) *tableWriter {
	return &tableWriter{tw: tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)}
}

func (t *tableWriter) row(format string, args ...any) {
	if t.err != nil {
		return
	}
	_, t.err = fmt.Fprintf(t.tw, format+"\n", args...)
}

func (t *tableWriter) flush() error {
	if t.err != nil {
		return t.err
	}
	return t.tw.Flush()
}

func printJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func wrapAPIError(err error) error {
	if client.StatusCode(err) == http.StatusUnauthorized {
		return fmt.Errorf("session expired — run 'jotctl login' again")
	}
	return err
}
