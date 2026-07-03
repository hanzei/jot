package cmd

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"strings"

	"github.com/hanzei/jot/server/client"
	"github.com/spf13/cobra"
)

//go:embed testdata/test-icon.png
var testIconData []byte

// imageMaxPerNoteSeed lets the "Home renovation" seed note demonstrate a
// gallery at capacity. Keep in sync with shared/src/constants.ts
// IMAGE_MAX_PER_NOTE / server/internal/handlers/note_images.go imageMaxPerNote.
const imageMaxPerNoteSeed = 10

// seedImageSize is the pixel width/height of generated sample note images —
// small enough that seeding stays fast even at imageMaxPerNoteSeed per note.
const seedImageSize = 64

// seedImagePalette cycles distinct solid colors across generated sample
// images so a note's gallery/grid doesn't show the same tile repeated.
var seedImagePalette = []color.RGBA{
	{R: 244, G: 67, B: 54, A: 255},  // red
	{R: 33, G: 150, B: 243, A: 255}, // blue
	{R: 76, G: 175, B: 80, A: 255},  // green
	{R: 255, G: 193, B: 7, A: 255},  // amber
	{R: 156, G: 39, B: 176, A: 255}, // purple
	{R: 0, G: 188, B: 212, A: 255},  // cyan
}

// seedImagePNG generates a small solid-color PNG for note-image seeding,
// picking a color from seedImagePalette by index so consecutive images
// visibly differ from one another.
func seedImagePNG(index int) ([]byte, error) {
	c := seedImagePalette[index%len(seedImagePalette)]
	img := image.NewRGBA(image.Rect(0, 0, seedImageSize, seedImageSize))
	for y := range seedImageSize {
		for x := range seedImageSize {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, fmt.Errorf("encode seed image: %w", err)
	}
	return buf.Bytes(), nil
}

// seedSummary is emitted as JSON when --json is set.
type seedSummary struct {
	UsersCreated  int `json:"users_created"`
	NotesCreated  int `json:"notes_created"`
	LabelsCreated int `json:"labels_created"`
	ImagesCreated int `json:"images_created"`
}

// resetSummary is emitted as JSON when --json is set.
type resetSummary struct {
	UsersDeleted int `json:"users_deleted"`
	NotesDeleted int `json:"notes_deleted"`
}

func (a *App) newSeedCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "seed",
		Short: "Add test data to the server (additive, safe to run multiple times)",
		RunE:  a.runSeedCmd,
	}
}

func (a *App) newResetCmd() *cobra.Command {
	var yes bool

	cmd := &cobra.Command{
		Use:   "reset",
		Short: "Delete all non-admin users and their data",
		RunE: func(cmd *cobra.Command, args []string) error {
			return a.runResetCmd(cmd, args, yes)
		},
	}
	cmd.Flags().BoolVar(&yes, "yes", false, "Skip confirmation prompt")
	return cmd
}

func (a *App) runSeedCmd(cmd *cobra.Command, _ []string) error {
	usersCreated, notesCreated, labelsCreated, imagesCreated, err := a.runSeed(cmd.Context(), a.client)
	if err != nil {
		return wrapAPIError(err)
	}
	return a.printSeedSummary(usersCreated, notesCreated, labelsCreated, imagesCreated)
}

func (a *App) printSeedSummary(usersCreated, notesCreated, labelsCreated, imagesCreated int) error {
	if a.jsonOutput {
		return a.printJSON(seedSummary{
			UsersCreated:  usersCreated,
			NotesCreated:  notesCreated,
			LabelsCreated: labelsCreated,
			ImagesCreated: imagesCreated,
		})
	}
	a.printf("Done. %d users, %d notes, %d labels, %d images created.\n", usersCreated, notesCreated, labelsCreated, imagesCreated)
	return nil
}

func (a *App) runResetCmd(cmd *cobra.Command, _ []string, yes bool) error {
	if !yes {
		a.printf("This will DELETE all non-admin users and ALL notes (including your own) on %s. Continue? [y/N]: ", a.client.BaseURL())
		var answer string
		fmt.Scanln(&answer) //nolint:errcheck,gosec // interactive prompt; partial input is treated as "no"
		if strings.ToLower(strings.TrimSpace(answer)) != "y" {
			a.printf("Aborted.\n")
			return nil
		}
	}

	me, err := a.client.Me(cmd.Context())
	if err != nil {
		return wrapAPIError(fmt.Errorf("get current user: %w", err))
	}

	users, err := a.client.AdminListUsers(cmd.Context())
	if err != nil {
		return wrapAPIError(fmt.Errorf("list users: %w", err))
	}

	// Wipe every admin's notes (including the current user's). Non-admin users
	// are deleted below, which removes their notes via cascade.
	notesDeleted, err := deleteAdminNotes(cmd.Context(), a.client, users)
	if err != nil {
		return wrapAPIError(err)
	}
	if !a.jsonOutput && notesDeleted > 0 {
		a.printf("  ✓ Deleted %d notes\n", notesDeleted)
	}

	usersDeleted, err := a.deleteNonAdminUsers(cmd.Context(), a.client, users, me.User.ID)
	if err != nil {
		return wrapAPIError(err)
	}

	if a.jsonOutput {
		return a.printJSON(resetSummary{UsersDeleted: usersDeleted, NotesDeleted: notesDeleted})
	}
	a.printf("Done. %d users and %d notes deleted.\n", usersDeleted, notesDeleted)
	return nil
}

// deleteAdminNotes permanently removes every note owned by each admin user
// (including the current user). Returns the total number of notes deleted.
func deleteAdminNotes(ctx context.Context, c *client.Client, users []*client.User) (int, error) {
	notesDeleted := 0
	for _, u := range users {
		if u.Role != client.RoleAdmin {
			continue
		}
		deleted, err := c.AdminDeleteUserNotes(ctx, u.ID)
		if err != nil {
			return 0, fmt.Errorf("delete notes for %s: %w", u.Username, err)
		}
		notesDeleted += deleted
	}
	return notesDeleted, nil
}

// deleteNonAdminUsers deletes every non-admin user (which removes their notes
// via cascade), skipping the current user. Returns the number of users deleted.
func (a *App) deleteNonAdminUsers(ctx context.Context, c *client.Client, users []*client.User, selfID string) (int, error) {
	usersDeleted := 0
	for _, u := range users {
		if u.ID == selfID || u.Role == client.RoleAdmin {
			continue
		}
		if err := c.AdminDeleteUser(ctx, u.ID); err != nil {
			return 0, fmt.Errorf("delete user %s: %w", u.Username, err)
		}
		if !a.jsonOutput {
			a.printf("  ✓ Deleted user %s\n", u.Username)
		}
		usersDeleted++
	}
	return usersDeleted, nil
}

// runSeed creates all seed users and their notes/settings via the API.
// Returns (usersCreated, notesCreated, labelsCreated, imagesCreated, error).
func (a *App) runSeed(ctx context.Context, adminClient *client.Client) (int, int, int, int, error) { //nolint:gocognit,gocyclo
	logf := func(format string, args ...any) {
		if !a.jsonOutput {
			a.printf(format+"\n", args...)
		}
	}

	if !a.jsonOutput {
		a.printf("Seeding test data on %s...\n", adminClient.BaseURL())
	}

	// Pre-load existing users so we can warn-and-skip duplicates while still
	// recording their IDs for cross-user sharing operations.
	existingUsers, err := adminClient.AdminListUsers(ctx)
	if err != nil {
		return 0, 0, 0, 0, fmt.Errorf("list existing users: %w", err)
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
			if !a.jsonOutput {
				a.printf("  ⚠ User %s already exists, skipping\n", u.username)
			}
			userIDs[u.username] = id
			continue
		}
		created, err := adminClient.AdminCreateUser(ctx, u.username, u.password, client.RoleUser)
		if err != nil {
			return 0, 0, 0, 0, fmt.Errorf("create user %s: %w", u.username, err)
		}
		userIDs[u.username] = created.ID
		logf("  ✓ Created user %s", u.username)
		usersCreated++
	}

	// Phase 2: per-user login → icon, settings, notes.
	notesCreated := 0
	labelsCreated := 0
	imagesCreated := 0
	for _, u := range seedDataset {
		if _, existed := existingByUsername[u.username]; existed {
			continue
		}

		uc := client.New(adminClient.BaseURL())
		if _, err := uc.Login(ctx, u.username, u.password); err != nil {
			return 0, 0, 0, 0, fmt.Errorf("login as %s: %w", u.username, err)
		}

		if u.profileIcon {
			if _, err := uc.UploadProfileIcon(ctx, "icon.png", bytes.NewReader(testIconData)); err != nil {
				return 0, 0, 0, 0, fmt.Errorf("upload icon for %s: %w", u.username, err)
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
			return 0, 0, 0, 0, fmt.Errorf("update settings for %s: %w", u.username, err)
		}
		logf("  ✓ Updated settings for %s (theme: %s, sort: %s, lang: %s)", u.username, u.theme, u.noteSort, u.language)

		userNoteCount := 0
		userImageCount := 0
		sharesPerUser := make(map[string]int)
		var uniqueLabels []string
		labelSeen := make(map[string]bool)

		for _, n := range u.notes {
			noteID, err := createNote(ctx, uc, n)
			if err != nil {
				return 0, 0, 0, 0, fmt.Errorf("create note for %s: %w", u.username, err)
			}

			// Images must be uploaded before trashing: a trashed note fails
			// the note-access check the upload endpoint relies on.
			for i := range n.imageCount {
				data, err := seedImagePNG(imagesCreated + i)
				if err != nil {
					return 0, 0, 0, 0, err
				}
				filename := fmt.Sprintf("sample-%d.png", i+1)
				if _, err := uc.UploadNoteImage(ctx, noteID, filename, bytes.NewReader(data)); err != nil {
					return 0, 0, 0, 0, fmt.Errorf("upload image for %s: %w", u.username, err)
				}
			}
			userImageCount += n.imageCount

			for _, targetUsername := range n.shareWith {
				targetID, ok := userIDs[targetUsername]
				if !ok {
					return 0, 0, 0, 0, fmt.Errorf("share target user %q not found in seed dataset", targetUsername)
				}
				if err := uc.ShareNote(ctx, noteID, targetID); err != nil {
					return 0, 0, 0, 0, fmt.Errorf("share note with %s: %w", targetUsername, err)
				}
				sharesPerUser[targetUsername]++
			}

			if n.trashed {
				if err := uc.DeleteNote(ctx, noteID); err != nil {
					return 0, 0, 0, 0, fmt.Errorf("trash note for %s: %w", u.username, err)
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
		imagesCreated += userImageCount
		logf("  ✓ Created %d notes for %s", userNoteCount, u.username)
		if userImageCount > 0 {
			logf("  ✓ Uploaded %d images for %s", userImageCount, u.username)
		}
		if len(uniqueLabels) > 0 {
			logf("  ✓ Applied labels: %s", strings.Join(uniqueLabels, ", "))
		}
		for targetUsername, count := range sharesPerUser {
			logf("  ✓ Shared %d notes with %s", count, targetUsername)
		}
	}

	return usersCreated, notesCreated, labelsCreated, imagesCreated, nil
}

// createNote creates one note (text or list) and applies any post-create
// mutations (pinned, archived, checkedItemsCollapsed). It returns the note ID.
// Trashing is handled by the caller after sharing is done.
func createNote(ctx context.Context, uc *client.Client, n seedNote) (string, error) { //nolint:gocognit
	switch n.noteType {
	case client.NoteTypeText:
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

	case client.NoteTypeList:
		items := make([]client.CreateNoteItem, len(n.items))
		for i, item := range n.items {
			items[i] = client.CreateNoteItem{
				Text:        item.text,
				Completed:   item.completed,
				Position:    i,
				IndentLevel: item.indentLevel,
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
