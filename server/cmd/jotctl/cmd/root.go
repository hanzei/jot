package cmd

import (
	jsontext "encoding/json/jsontext"
	"encoding/json/v2"
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

// App holds shared state for a single jotctl invocation.
type App struct {
	out        io.Writer
	jsonOutput bool
	client     *client.Client
}

// NewApp creates an App that writes output to out.
func NewApp(out io.Writer) *App {
	return &App{out: out}
}

// Execute is the entry point for the jotctl binary.
func Execute() {
	app := NewApp(os.Stdout)
	if err := app.newRootCmd().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}

func (a *App) newRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:   "jotctl",
		Short: "Jot admin CLI",
		Long:  "jotctl manages users on a Jot server.\n\nRun 'jotctl login' first to authenticate.",
		PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
			return a.loadSession()
		},
		// Errors are printed once by Execute; without these flags cobra would
		// swallow the error message and dump the command usage instead.
		SilenceErrors: true,
		SilenceUsage:  true,
	}

	root.PersistentFlags().BoolVar(&a.jsonOutput, "json", false, "Output as JSON")
	root.AddCommand(a.newLoginCmd())
	root.AddCommand(a.newLogoutCmd())
	root.AddCommand(a.newDevCmd())
	root.AddCommand(a.newUsersCmd())
	root.AddCommand(a.newVersionCmd())

	return root
}

func (a *App) loadSession() error {
	sf, err := readSessionFile()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("not logged in — run 'jotctl login' first")
		}
		return fmt.Errorf("load session: %w", err)
	}

	a.client = client.New(sf.Server)

	u, err := url.Parse(sf.Server)
	if err != nil {
		return fmt.Errorf("invalid server URL in session file: %w", err)
	}

	a.client.HTTPClient().Jar.SetCookies(u, []*http.Cookie{
		//nolint:gosec // outgoing cookie sent by this CLI client, not a server response; Secure/HttpOnly/SameSite are response-only attributes
		{Name: sessionCookieName, Value: sf.SessionToken},
	})

	return nil
}

// sessionData is persisted to disk by the login command.
type sessionData struct {
	Server       string `json:"server"`
	SessionToken string `json:"session_token"`
}

// sessionFilePath returns the path to the session file.
// If JOTCTL_CONFIG_DIR is set it is used as the parent directory, which
// allows tests to redirect the file without touching the real user config.
func sessionFilePath() (string, error) {
	if dir := os.Getenv("JOTCTL_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "session"), nil
	}
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

	if err = os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}

	// The session token is intentionally persisted to disk here for reuse across
	// invocations; the file is written with 0600 permissions below.
	data, err := json.Marshal(sd)
	if err != nil {
		return fmt.Errorf("marshal session: %w", err)
	}

	if err = os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write session file: %w", err)
	}

	// os.WriteFile does not reset permissions on an existing file, so force
	// 0600 explicitly to defend against a pre-existing file with loose perms.
	if err = os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("chmod session file: %w", err)
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

// printf writes a formatted string to a.out. Write errors are intentionally
// discarded: a.out is either os.Stdout (CLI) or a bytes.Buffer (tests), and
// neither can meaningfully fail.
func (a *App) printf(format string, args ...any) {
	fmt.Fprintf(a.out, format, args...) //nolint:errcheck
}

func (a *App) printJSON(v any) error {
	if err := json.MarshalWrite(a.out, v, jsontext.WithIndent("  ")); err != nil {
		return fmt.Errorf("marshal json output: %w", err)
	}
	// MarshalWrite omits the trailing newline that json.Encoder.Encode wrote.
	if _, err := io.WriteString(a.out, "\n"); err != nil {
		return fmt.Errorf("write json output: %w", err)
	}
	return nil
}

func wrapAPIError(err error) error {
	if client.StatusCode(err) == http.StatusUnauthorized {
		return fmt.Errorf("session expired — run 'jotctl login' again")
	}
	return err
}
