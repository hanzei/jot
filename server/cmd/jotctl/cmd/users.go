package cmd

import (
	"crypto/rand"
	"fmt"
	"os"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

func (a *App) newUsersCmd() *cobra.Command {
	usersCmd := &cobra.Command{
		Use:   "users",
		Short: "Manage users",
	}
	usersCmd.AddCommand(a.newUsersListCmd())
	usersCmd.AddCommand(a.newUsersCreateCmd())
	usersCmd.AddCommand(a.newUsersDeleteCmd())
	usersCmd.AddCommand(a.newUsersSetRoleCmd())
	usersCmd.AddCommand(a.newUsersSetPasswordCmd())
	return usersCmd
}

func (a *App) newUsersListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List all users",
		RunE:  a.runUsersList,
	}
}

func (a *App) newUsersCreateCmd() *cobra.Command {
	var username, password, role string

	cmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new user",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return a.runUsersCreate(cmd, username, password, role)
		},
	}
	cmd.Flags().StringVarP(&username, "username", "u", "", "Username (required)")
	cmd.Flags().StringVarP(&password, "password", "p", "", "Password (required)")
	cmd.Flags().StringVar(&role, "role", string(client.RoleUser), "Role: user or admin")
	_ = cmd.MarkFlagRequired("username")
	_ = cmd.MarkFlagRequired("password")
	return cmd
}

func (a *App) newUsersDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "delete <id>",
		Short: "Delete a user by ID",
		Args:  cobra.ExactArgs(1),
		RunE:  a.runUsersDelete,
	}
}

func (a *App) newUsersSetRoleCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set-role <id> <role>",
		Short: "Change a user's role (user or admin)",
		Args:  cobra.ExactArgs(2),
		RunE:  a.runUsersSetRole,
	}
}

func (a *App) newUsersSetPasswordCmd() *cobra.Command {
	var password string
	var generate bool

	cmd := &cobra.Command{
		Use:   "set-password <id>",
		Short: "Set a user's password (admin account recovery)",
		Long: "Set a new password for a user without knowing their current one.\n\n" +
			"The password is read from a secure prompt unless --password or --generate\n" +
			"is given. All of the target user's existing sessions are invalidated.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.runUsersSetPassword(cmd, args[0], password, generate)
		},
	}
	cmd.Flags().StringVarP(&password, "password", "p", "", "New password (prompted securely if omitted)")
	cmd.Flags().BoolVar(&generate, "generate", false, "Generate a strong random password and print it")
	return cmd
}

func (a *App) runUsersList(cmd *cobra.Command, _ []string) error {
	users, err := a.client.AdminListUsers(cmd.Context())
	if err != nil {
		return wrapAPIError(err)
	}

	if a.jsonOutput {
		return a.printJSON(users)
	}

	tw := newTableWriter(a.out)
	tw.row("%-22s  %-20s  %-8s  %s", "ID", "USERNAME", "ROLE", "CREATED")
	tw.row("%-22s  %-20s  %-8s  %s", "----------------------", "--------------------", "--------", "-------")
	for _, u := range users {
		tw.row("%-22s  %-20s  %-8s  %s", u.ID, u.Username, u.Role, u.CreatedAt.Format(time.RFC3339))
	}
	return tw.flush()
}

func (a *App) runUsersCreate(cmd *cobra.Command, username, password, roleStr string) error {
	role := client.Role(roleStr)
	if err := validateRole(role); err != nil {
		return err
	}

	u, err := a.client.AdminCreateUser(cmd.Context(), username, password, role)
	if err != nil {
		return wrapAPIError(err)
	}

	if a.jsonOutput {
		return a.printJSON(u)
	}

	a.printf("Created user %s (ID: %s, role: %s)\n", u.Username, u.ID, u.Role)
	return nil
}

type deleteResult struct {
	ID      string `json:"id"`
	Deleted bool   `json:"deleted"`
}

func (a *App) runUsersDelete(cmd *cobra.Command, args []string) error {
	userID := args[0]

	if err := a.client.AdminDeleteUser(cmd.Context(), userID); err != nil {
		return wrapAPIError(err)
	}

	if a.jsonOutput {
		return a.printJSON(deleteResult{ID: userID, Deleted: true})
	}
	a.printf("Deleted user %s\n", userID)
	return nil
}

func (a *App) runUsersSetRole(cmd *cobra.Command, args []string) error {
	userID := args[0]
	role := client.Role(args[1])

	if err := validateRole(role); err != nil {
		return err
	}

	u, err := a.client.AdminUpdateUserRole(cmd.Context(), userID, role)
	if err != nil {
		return wrapAPIError(err)
	}

	if a.jsonOutput {
		return a.printJSON(u)
	}

	a.printf("Updated user %s role to %s\n", u.Username, u.Role)
	return nil
}

func validateRole(role client.Role) error {
	if role != client.RoleUser && role != client.RoleAdmin {
		return fmt.Errorf("invalid role %q: must be %q or %q", role, client.RoleUser, client.RoleAdmin)
	}
	return nil
}

type setPasswordResult struct {
	ID                string `json:"id"`
	Updated           bool   `json:"updated"`
	GeneratedPassword string `json:"generated_password,omitempty"`
}

func (a *App) runUsersSetPassword(cmd *cobra.Command, userID, password string, generate bool) error {
	var generated string
	switch {
	case generate:
		if password != "" {
			return fmt.Errorf("--generate cannot be combined with --password")
		}
		// Generate at least the server's configured minimum length so the
		// generated password always passes validation. The config endpoint is
		// public; if it is unreachable, fall back to the baseline length and let
		// the server reject a too-short password with a clear error.
		length := generatedPasswordLength
		if cfg, err := a.client.Config(cmd.Context()); err == nil && cfg.PasswordMinLength > length {
			length = cfg.PasswordMinLength
		}
		pw, err := generatePassword(length)
		if err != nil {
			return fmt.Errorf("generate password: %w", err)
		}
		password = pw
		generated = pw
	case password == "":
		a.printf("New password: ")
		pw, err := term.ReadPassword(int(os.Stdin.Fd()))
		if err != nil {
			return fmt.Errorf("read password: %w", err)
		}
		a.printf("\n")
		password = string(pw)
	}

	if password == "" {
		return fmt.Errorf("password is required")
	}

	if err := a.client.AdminSetUserPassword(cmd.Context(), userID, password); err != nil {
		return wrapAPIError(err)
	}

	if a.jsonOutput {
		return a.printJSON(setPasswordResult{ID: userID, Updated: true, GeneratedPassword: generated})
	}

	if generated != "" {
		a.printf("Set password for user %s. All existing sessions were invalidated.\nGenerated password: %s\n", userID, generated)
	} else {
		a.printf("Set password for user %s. All existing sessions were invalidated.\n", userID)
	}
	return nil
}

// generatedPasswordLength is the baseline length for a generated password. The
// caller raises it to the server's configured minimum when that is longer, so a
// generated password always satisfies validation.
const generatedPasswordLength = 24

// generatePassword returns a cryptographically random alphanumeric password of
// the given length. It mirrors the rejection-sampling approach in
// internal/models.generateID to avoid modulo bias without importing that
// internal package into the CLI.
func generatePassword(length int) (string, error) {
	const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	const maxByte = 256 - (256 % len(chars))
	result := make([]byte, length)
	var buf [1]byte
	for i := range length {
		for {
			if _, err := rand.Read(buf[:]); err != nil {
				return "", err
			}
			if int(buf[0]) < maxByte {
				result[i] = chars[int(buf[0])%len(chars)]
				break
			}
		}
	}
	return string(result), nil
}
