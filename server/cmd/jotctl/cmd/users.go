package cmd

import (
	"fmt"
	"os"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/spf13/cobra"
)

var usersCmd = &cobra.Command{
	Use:   "users",
	Short: "Manage users",
}

var usersListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all users",
	RunE:  runUsersList,
}

var (
	createUsername string
	createPassword string
	createRole     string
)

var usersCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a new user",
	RunE:  runUsersCreate,
}

var usersDeleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "Delete a user by ID",
	Args:  cobra.ExactArgs(1),
	RunE:  runUsersDelete,
}

var usersSetRoleCmd = &cobra.Command{
	Use:   "set-role <id> <role>",
	Short: "Change a user's role (user or admin)",
	Args:  cobra.ExactArgs(2),
	RunE:  runUsersSetRole,
}

func init() {
	usersCreateCmd.Flags().StringVarP(&createUsername, "username", "u", "", "Username (required)")
	usersCreateCmd.Flags().StringVarP(&createPassword, "password", "p", "", "Password (required)")
	usersCreateCmd.Flags().StringVar(&createRole, "role", string(client.RoleUser), "Role: user or admin")
	_ = usersCreateCmd.MarkFlagRequired("username")
	_ = usersCreateCmd.MarkFlagRequired("password")

	usersCmd.AddCommand(usersListCmd)
	usersCmd.AddCommand(usersCreateCmd)
	usersCmd.AddCommand(usersDeleteCmd)
	usersCmd.AddCommand(usersSetRoleCmd)
}

func runUsersList(cmd *cobra.Command, _ []string) error {
	users, err := jotClient.AdminListUsers(cmd.Context())
	if err != nil {
		return wrapAPIError(err)
	}

	if jsonOutput {
		return printJSON(users)
	}

	tw := newTableWriter(os.Stdout)
	tw.row("%-22s  %-20s  %-8s  %s", "ID", "USERNAME", "ROLE", "CREATED")
	tw.row("%-22s  %-20s  %-8s  %s", "----------------------", "--------------------", "--------", "-------")
	for _, u := range users {
		tw.row("%-22s  %-20s  %-8s  %s", u.ID, u.Username, u.Role, u.CreatedAt.Format(time.RFC3339))
	}
	return tw.flush()
}

func runUsersCreate(cmd *cobra.Command, _ []string) error {
	role := client.Role(createRole)
	if err := validateRole(role); err != nil {
		return err
	}

	u, err := jotClient.AdminCreateUser(cmd.Context(), createUsername, createPassword, role)
	if err != nil {
		return wrapAPIError(err)
	}

	if jsonOutput {
		return printJSON(u)
	}

	fmt.Printf("Created user %s (ID: %s, role: %s)\n", u.Username, u.ID, u.Role)
	return nil
}

func runUsersDelete(cmd *cobra.Command, args []string) error {
	userID := args[0]

	if err := jotClient.AdminDeleteUser(cmd.Context(), userID); err != nil {
		return wrapAPIError(err)
	}

	fmt.Printf("Deleted user %s\n", userID)
	return nil
}

func runUsersSetRole(cmd *cobra.Command, args []string) error {
	userID := args[0]
	role := client.Role(args[1])

	if err := validateRole(role); err != nil {
		return err
	}

	u, err := jotClient.AdminUpdateUserRole(cmd.Context(), userID, role)
	if err != nil {
		return wrapAPIError(err)
	}

	if jsonOutput {
		return printJSON(u)
	}

	fmt.Printf("Updated user %s role to %s\n", u.Username, u.Role)
	return nil
}

func validateRole(role client.Role) error {
	if role != client.RoleUser && role != client.RoleAdmin {
		return fmt.Errorf("invalid role %q: must be %q or %q", role, client.RoleUser, client.RoleAdmin)
	}
	return nil
}
