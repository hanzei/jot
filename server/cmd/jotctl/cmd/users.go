package cmd

import (
	"fmt"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/spf13/cobra"
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

	fmt.Fprintf(a.out, "Created user %s (ID: %s, role: %s)\n", u.Username, u.ID, u.Role)
	return nil
}

func (a *App) runUsersDelete(cmd *cobra.Command, args []string) error {
	userID := args[0]

	if err := a.client.AdminDeleteUser(cmd.Context(), userID); err != nil {
		return wrapAPIError(err)
	}

	fmt.Fprintf(a.out, "Deleted user %s\n", userID)
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

	fmt.Fprintf(a.out, "Updated user %s role to %s\n", u.Username, u.Role)
	return nil
}

func validateRole(role client.Role) error {
	if role != client.RoleUser && role != client.RoleAdmin {
		return fmt.Errorf("invalid role %q: must be %q or %q", role, client.RoleUser, client.RoleAdmin)
	}
	return nil
}
