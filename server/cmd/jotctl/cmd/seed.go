package cmd

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"os"
	"strings"

	"github.com/hanzei/jot/server/client"
	"github.com/spf13/cobra"
)

//go:embed testdata/test-icon.png
var testIconData []byte

// seedSummary is emitted as JSON when --json is set.
type seedSummary struct {
	UsersCreated  int `json:"users_created"`
	NotesCreated  int `json:"notes_created"`
	LabelsCreated int `json:"labels_created"`
}

var seedCmd = &cobra.Command{
	Use:   "seed",
	Short: "Add test data to the server (additive, safe to run multiple times)",
	RunE:  runSeedCmd,
}

var resetYes bool

var resetCmd = &cobra.Command{
	Use:   "reset",
	Short: "Delete all non-admin users and their data, then reseed",
	RunE:  runResetCmd,
}

func init() {
	resetCmd.Flags().BoolVar(&resetYes, "yes", false, "Skip confirmation prompt")
}

func runSeedCmd(cmd *cobra.Command, _ []string) error {
	usersCreated, notesCreated, labelsCreated, err := runSeed(cmd.Context(), jotClient, jsonOutput)
	if err != nil {
		return wrapAPIError(err)
	}
	if jsonOutput {
		return printJSON(seedSummary{
			UsersCreated:  usersCreated,
			NotesCreated:  notesCreated,
			LabelsCreated: labelsCreated,
		})
	}
	fmt.Printf("Done. %d users, %d notes, %d labels created.\n", usersCreated, notesCreated, labelsCreated)
	return nil
}

func runResetCmd(cmd *cobra.Command, _ []string) error {
	if !resetYes {
		fmt.Printf("This will DELETE all non-admin users and their data on %s. Continue? [y/N]: ", jotClient.BaseURL())
		var answer string
		fmt.Scanln(&answer) //nolint:errcheck,gosec // interactive prompt; partial input is treated as "no"
		if strings.ToLower(strings.TrimSpace(answer)) != "y" {
			fmt.Println("Aborted.")
			return nil
		}
	}

	me, err := jotClient.Me(cmd.Context())
	if err != nil {
		return wrapAPIError(fmt.Errorf("get current user: %w", err))
	}

	users, err := jotClient.AdminListUsers(cmd.Context())
	if err != nil {
		return wrapAPIError(fmt.Errorf("list users: %w", err))
	}

	for _, u := range users {
		if u.ID == me.User.ID || u.Role == client.RoleAdmin {
			continue
		}
		if deleteErr := jotClient.AdminDeleteUser(cmd.Context(), u.ID); deleteErr != nil {
			return wrapAPIError(fmt.Errorf("delete user %s: %w", u.Username, deleteErr))
		}
		if !jsonOutput {
			fmt.Printf("  ✓ Deleted user %s\n", u.Username)
		}
	}

	usersCreated, notesCreated, labelsCreated, err := runSeed(cmd.Context(), jotClient, jsonOutput)
	if err != nil {
		return wrapAPIError(err)
	}
	if jsonOutput {
		return printJSON(seedSummary{
			UsersCreated:  usersCreated,
			NotesCreated:  notesCreated,
			LabelsCreated: labelsCreated,
		})
	}
	fmt.Printf("Done. %d users, %d notes, %d labels created.\n", usersCreated, notesCreated, labelsCreated)
	return nil
}

// runSeed creates all seed users and their notes/settings via the API.
// Returns (usersCreated, notesCreated, labelsCreated, error).
func runSeed(ctx context.Context, adminClient *client.Client, jsonOutput bool) (int, int, int, error) { //nolint:gocognit,gocyclo
	logf := func(format string, args ...any) {
		if !jsonOutput {
			fmt.Printf(format+"\n", args...)
		}
	}

	if !jsonOutput {
		fmt.Printf("Seeding test data on %s...\n", adminClient.BaseURL())
	}

	// Pre-load existing users so we can warn-and-skip duplicates while still
	// recording their IDs for cross-user sharing operations.
	existingUsers, err := adminClient.AdminListUsers(ctx)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("list existing users: %w", err)
	}
	existingByUsername := make(map[string]string, len(existingUsers))
	for _, u := range existingUsers {
		existingByUsername[u.Username] = u.ID
	}

	// Phase 1: create all seed users via the admin API.
	userIDs := make(map[string]string, len(seedDataset))
	usersCreated := 0
	for _, u := range seedDataset {
		if id, exists := existingByUsername[u.username]; exists {
			if !jsonOutput {
				fmt.Fprintf(os.Stderr, "  ⚠ User %s already exists, skipping\n", u.username)
			}
			userIDs[u.username] = id
			continue
		}
		created, err := adminClient.AdminCreateUser(ctx, u.username, u.password, client.RoleUser)
		if err != nil {
			return 0, 0, 0, fmt.Errorf("create user %s: %w", u.username, err)
		}
		userIDs[u.username] = created.ID
		logf("  ✓ Created user %s", u.username)
		usersCreated++
	}

	// Phase 2: per-user login → icon, settings, notes.
	notesCreated := 0
	labelsCreated := 0
	for _, u := range seedDataset {
		if _, existed := existingByUsername[u.username]; existed {
			continue
		}

		uc := client.New(adminClient.BaseURL())
		if _, err := uc.Login(ctx, u.username, u.password); err != nil {
			return 0, 0, 0, fmt.Errorf("login as %s: %w", u.username, err)
		}

		if u.profileIcon {
			if _, err := uc.UploadProfileIcon(ctx, "icon.png", bytes.NewReader(testIconData)); err != nil {
				return 0, 0, 0, fmt.Errorf("upload icon for %s: %w", u.username, err)
			}
			logf("  ✓ Uploaded profile icon for %s", u.username)
		}

		if _, err := uc.UpdateUser(ctx, &client.UpdateUserRequest{
			FirstName: client.Ptr(u.firstName),
			LastName:  client.Ptr(u.lastName),
			Theme:     client.Ptr(u.theme),
			NoteSort:  client.Ptr(u.noteSort),
			Language:  client.Ptr(u.language),
		}); err != nil {
			return 0, 0, 0, fmt.Errorf("update settings for %s: %w", u.username, err)
		}
		logf("  ✓ Updated settings for %s (theme: %s, sort: %s, lang: %s)", u.username, u.theme, u.noteSort, u.language)

		userNoteCount := 0
		sharesPerUser := make(map[string]int)
		var uniqueLabels []string
		labelSeen := make(map[string]bool)

		for _, n := range u.notes {
			noteID, err := createNote(ctx, uc, n)
			if err != nil {
				return 0, 0, 0, fmt.Errorf("create note for %s: %w", u.username, err)
			}

			for _, targetUsername := range n.shareWith {
				targetID, ok := userIDs[targetUsername]
				if !ok {
					return 0, 0, 0, fmt.Errorf("share target user %q not found in seed dataset", targetUsername)
				}
				if err := uc.ShareNote(ctx, noteID, targetID); err != nil {
					return 0, 0, 0, fmt.Errorf("share note with %s: %w", targetUsername, err)
				}
				sharesPerUser[targetUsername]++
			}

			if n.trashed {
				if err := uc.DeleteNote(ctx, noteID); err != nil {
					return 0, 0, 0, fmt.Errorf("trash note for %s: %w", u.username, err)
				}
			}

			for _, lbl := range n.labels {
				if !labelSeen[lbl] {
					labelSeen[lbl] = true
					uniqueLabels = append(uniqueLabels, lbl)
					labelsCreated++
				}
			}
			userNoteCount++
		}

		notesCreated += userNoteCount
		logf("  ✓ Created %d notes for %s", userNoteCount, u.username)
		if len(uniqueLabels) > 0 {
			logf("  ✓ Applied labels: %s", strings.Join(uniqueLabels, ", "))
		}
		for targetUsername, count := range sharesPerUser {
			logf("  ✓ Shared %d notes with %s", count, targetUsername)
		}
	}

	return usersCreated, notesCreated, labelsCreated, nil
}

// createNote creates one note (text or list) and applies any post-create
// mutations (pinned, archived, checkedItemsCollapsed). It returns the note ID.
// Trashing is handled by the caller after sharing is done.
func createNote(ctx context.Context, uc *client.Client, n seedNote) (string, error) { //nolint:gocognit
	switch n.noteType {
	case "text":
		created, err := uc.CreateTextNote(ctx, &client.CreateTextNoteRequest{
			Content: n.content,
			Color:   n.color,
			Labels:  n.labels,
		})
		if err != nil {
			return "", fmt.Errorf("create text note: %w", err)
		}
		if n.pinned || n.archived {
			upd := &client.UpdateTextNoteRequest{}
			if n.pinned {
				upd.Pinned = client.Ptr(true)
			}
			if n.archived {
				upd.Archived = client.Ptr(true)
			}
			if _, err := uc.UpdateTextNote(ctx, created.ID, upd); err != nil {
				return "", fmt.Errorf("update text note: %w", err)
			}
		}
		return created.ID, nil

	case "list":
		items := make([]client.CreateNoteItem, len(n.items))
		for i, item := range n.items {
			items[i] = client.CreateNoteItem{
				Text:      item.text,
				Completed: item.completed,
				Position:  i,
			}
		}
		created, err := uc.CreateListNote(ctx, &client.CreateListNoteRequest{
			Title:  n.title,
			Color:  n.color,
			Items:  items,
			Labels: n.labels,
		})
		if err != nil {
			return "", fmt.Errorf("create list note: %w", err)
		}
		if n.checkedItemsCollapsed || n.archived {
			upd := &client.UpdateListNoteRequest{}
			if n.checkedItemsCollapsed {
				upd.CheckedItemsCollapsed = client.Ptr(true)
			}
			if n.archived {
				upd.Archived = client.Ptr(true)
			}
			if _, err := uc.UpdateListNote(ctx, created.ID, upd); err != nil {
				return "", fmt.Errorf("update list note: %w", err)
			}
		}
		return created.ID, nil

	default:
		return "", fmt.Errorf("unknown note type: %q", n.noteType)
	}
}
