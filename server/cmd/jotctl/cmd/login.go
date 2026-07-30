package cmd

import (
	"bufio"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/hanzei/jot/server/client"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

func (a *App) newLoginCmd() *cobra.Command {
	var server, username, password string

	cmd := &cobra.Command{
		Use:   "login",
		Short: "Authenticate with a Jot server and save the session",
		// Override the root PersistentPreRunE: login manages its own auth.
		PersistentPreRunE: func(_ *cobra.Command, _ []string) error { return nil },
		RunE: func(cmd *cobra.Command, _ []string) error {
			return a.runLogin(cmd, server, username, password)
		},
	}
	cmd.Flags().StringVar(&server, "server", getEnv("JOTCTL_SERVER", "http://localhost:8080"), "Jot server URL ($JOTCTL_SERVER)")
	cmd.Flags().StringVarP(&username, "username", "u", getEnv("JOTCTL_USERNAME", ""), "Admin username ($JOTCTL_USERNAME)")
	cmd.Flags().StringVarP(&password, "password", "p", getEnv("JOTCTL_PASSWORD", ""), "Admin password ($JOTCTL_PASSWORD)")
	return cmd
}

func (a *App) newLogoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Log out and clear the saved session",
		// Override the root PersistentPreRunE: logout can run without a valid session.
		PersistentPreRunE: func(_ *cobra.Command, _ []string) error { return nil },
		RunE:              a.runLogout,
	}
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return fallback
}

func (a *App) runLogin(cmd *cobra.Command, server, username, password string) error {
	reader := bufio.NewReader(os.Stdin)

	if username == "" {
		a.printf("Username: ")
		input, err := reader.ReadString('\n')
		if err != nil {
			return fmt.Errorf("read username: %w", err)
		}
		username = strings.TrimSpace(input)
	}

	if password == "" {
		a.printf("Password: ")
		pw, err := term.ReadPassword(int(os.Stdin.Fd()))
		if err != nil {
			return fmt.Errorf("read password: %w", err)
		}
		a.printf("\n")
		password = string(pw)
	}

	if username == "" {
		return fmt.Errorf("username is required")
	}
	if password == "" {
		return fmt.Errorf("password is required")
	}

	c := client.New(server)
	if _, err := c.Login(cmd.Context(), username, password); err != nil {
		if client.StatusCode(err) == http.StatusUnauthorized {
			return fmt.Errorf("invalid credentials")
		}
		return fmt.Errorf("login failed: %w", err)
	}

	u, err := url.Parse(server)
	if err != nil {
		return fmt.Errorf("invalid server URL: %w", err)
	}

	var sessionToken string
	for _, cookie := range c.HTTPClient().Jar.Cookies(u) {
		if cookie.Name == sessionCookieName {
			sessionToken = cookie.Value
			break
		}
	}
	if sessionToken == "" {
		return fmt.Errorf("server did not return a session cookie")
	}

	if err := writeSessionFile(&sessionData{
		Server:       server,
		SessionToken: sessionToken,
	}); err != nil {
		return fmt.Errorf("save session: %w", err)
	}

	a.printf("Logged in as %s. Session saved.\n", username)
	return nil
}

func (a *App) runLogout(cmd *cobra.Command, _ []string) error {
	// Load the saved session to invalidate it server-side before removing the local file.
	// This runs even when root's PersistentPreRunE is bypassed (no session file required).
	sf, err := readSessionFile()
	if err == nil {
		c := client.New(sf.Server)
		u, urlErr := url.Parse(sf.Server)
		if urlErr == nil {
			c.HTTPClient().Jar.SetCookies(u, []*http.Cookie{
				//nolint:gosec // outgoing cookie sent by this CLI client, not a server response; Secure/HttpOnly/SameSite are response-only attributes
				{Name: sessionCookieName, Value: sf.SessionToken},
			})
		}
		_ = c.Logout(cmd.Context()) // best-effort: session may already be expired
	}

	if err = deleteSessionFile(); err != nil {
		return err
	}

	a.printf("Logged out.\n")
	return nil
}
