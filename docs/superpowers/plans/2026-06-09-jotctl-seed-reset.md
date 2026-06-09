# jotctl seed + reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `jotctl seed` and `jotctl reset` subcommands that populate a Jot server with rich test data (or wipe + repopulate it) using only the HTTP API.

**Architecture:** Two new files (`seeddata.go` for the dataset, `seed.go` for command logic) are added to `server/cmd/jotctl/cmd/`. A copied test icon in `testdata/` is embedded at compile time. The seed flow runs in two phases: create all users via the admin client, then per-user login to create notes/labels/settings. `reset` lists non-admin users, deletes them, then calls the same seed logic.

**Tech Stack:** Go, Cobra (already used by jotctl), `github.com/hanzei/jot/server/client` (existing Go client SDK), `//go:embed` for the icon

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `server/cmd/jotctl/cmd/testdata/test-icon.png` | Copy from `webapp/e2e/fixtures/test-icon.png` | Embeddable icon asset (must live inside the Go module) |
| `server/cmd/jotctl/cmd/seeddata.go` | Create | Hardcoded structs + dataset — no HTTP logic |
| `server/cmd/jotctl/cmd/seed.go` | Create | `runSeed`, `createNote`, `runSeedCmd`, `runResetCmd`, cobra command vars |
| `server/cmd/jotctl/cmd/root.go` | Modify | Register `seedCmd` and `resetCmd` in `init()` |

> **Embed note:** `//go:embed` paths must be within the Go module root (`server/`). The webapp fixture is outside that boundary, so the icon is copied to `server/cmd/jotctl/cmd/testdata/` — this is the only correct approach.

---

## Task 1: Copy the test icon into the module

**Files:**
- Create: `server/cmd/jotctl/cmd/testdata/test-icon.png`

- [ ] **Step 1.1: Copy the icon**

```bash
mkdir -p server/cmd/jotctl/cmd/testdata
cp webapp/e2e/fixtures/test-icon.png server/cmd/jotctl/cmd/testdata/test-icon.png
```

- [ ] **Step 1.2: Verify the file exists and is non-empty**

```bash
ls -lh server/cmd/jotctl/cmd/testdata/test-icon.png
```

Expected: file listed with non-zero size.

- [ ] **Step 1.3: Commit**

```bash
git add server/cmd/jotctl/cmd/testdata/test-icon.png
git commit -m "chore: add embedded test icon for jotctl seed command"
```

---

## Task 2: Create seeddata.go

**Files:**
- Create: `server/cmd/jotctl/cmd/seeddata.go`

This file is pure data — no imports, no HTTP calls. It defines the structs and the `seedDataset` slice that `seed.go` iterates over.

- [ ] **Step 2.1: Create the file**

```go
// server/cmd/jotctl/cmd/seeddata.go
package cmd

type seedItem struct {
	text      string
	completed bool
}

type seedNote struct {
	noteType              string // "text" or "list"
	content               string // text notes
	title                 string // list notes
	color                 string
	pinned                bool
	archived              bool
	trashed               bool
	checkedItemsCollapsed bool
	items                 []seedItem
	labels                []string
	shareWith             []string // usernames to share this note with
}

type seedUser struct {
	username    string
	firstName   string
	lastName    string
	password    string
	theme       string
	noteSort    string
	language    string
	profileIcon bool
	notes       []seedNote
}

const seedPassword = "test"

// seedDataset covers every valid theme (system/light/dark), every NoteSort
// (manual/updated_at/created_at), and a representative spread of note states.
var seedDataset = []seedUser{
	{
		username:    "alice",
		firstName:   "Alice",
		password:    seedPassword,
		theme:       "dark",
		noteSort:    "manual",
		language:    "en",
		profileIcon: true,
		notes: []seedNote{
			// active text notes (4)
			{
				noteType: "text",
				content: "# Project Notes\n\n**Important:** Check the _deadline_ before Thursday.\n\n" +
					"Install with `npm install`:\n\n```bash\nnpm install\nnpm start\n```\n\n" +
					"See [the docs](https://example.com) for full reference.",
				labels:    []string{"work"},
				shareWith: []string{"bob"},
			},
			{
				noteType:  "text",
				content:   "Pick up groceries on the way home",
				pinned:    true,
				labels:    []string{"personal"},
				shareWith: []string{"bob"},
			},
			{
				noteType: "text",
				content:  "Build a note-taking app with offline support and mobile sync",
				color:    "blue",
				labels:   []string{"ideas"},
			},
			{
				noteType: "text",
				content:  "Call dentist to reschedule appointment",
			},
			// active list notes (3)
			{
				noteType:  "list",
				title:     "Sprint tasks",
				labels:    []string{"urgent"},
				shareWith: []string{"bob"},
				items: []seedItem{
					{text: "Review pull requests", completed: true},
					{text: "Update documentation", completed: false},
					{text: "Fix failing tests", completed: false},
				},
			},
			{
				noteType:              "list",
				title:                 "Reading list",
				checkedItemsCollapsed: true,
				items: []seedItem{
					{text: "The Pragmatic Programmer", completed: true},
					{text: "Clean Code", completed: true},
					{text: "Designing Data-Intensive Applications", completed: false},
				},
			},
			{
				noteType: "list",
				title:    "Groceries",
				items: []seedItem{
					{text: "Apples", completed: false},
					{text: "Bread", completed: false},
					{text: "Coffee", completed: true},
				},
			},
			// archived notes (3)
			{noteType: "text", content: "Old meeting notes from Q3", archived: true},
			{noteType: "text", content: "Draft blog post: Getting started with Go", archived: true},
			{
				noteType: "list",
				title:    "Old shopping list",
				archived: true,
				items:    []seedItem{{text: "Milk"}, {text: "Eggs"}},
			},
			// trashed notes (3)
			{noteType: "text", content: "Temporary scratch note", trashed: true},
			{noteType: "text", content: "Draft email that was never sent", trashed: true},
			{
				noteType: "list",
				title:    "Abandoned todo list",
				trashed:  true,
				items:    []seedItem{{text: "Task A"}, {text: "Task B"}},
			},
		},
	},
	{
		username:  "bob",
		firstName: "Bob",
		lastName:  "Smith",
		password:  seedPassword,
		theme:     "light",
		noteSort:  "updated_at",
		language:  "de",
		notes: []seedNote{
			{noteType: "text", content: "Work in progress: API design notes", labels: []string{"work"}},
			{noteType: "text", content: "Team standup notes"},
			{noteType: "text", content: "Monthly goals and OKRs"},
		},
	},
	{
		username:  "carol",
		firstName: "Carol",
		password:  seedPassword,
		theme:     "system",
		noteSort:  "created_at",
		language:  "fr",
		notes: []seedNote{
			{noteType: "text", content: "Learning French vocabulary: bonjour, merci, au revoir"},
			{noteType: "text", content: "Recipe: Quiche Lorraine\n\nIngredients: eggs, cream, bacon, gruyère"},
			{noteType: "text", content: "Travel itinerary for Paris trip in July"},
		},
	},
}
```

- [ ] **Step 2.2: Verify the file compiles (no logic errors)**

```bash
cd server && go build ./cmd/jotctl/...
```

Expected: no errors.

- [ ] **Step 2.3: Commit**

```bash
git add server/cmd/jotctl/cmd/seeddata.go
git commit -m "feat(jotctl): add seed dataset structs"
```

---

## Task 3: Create seed.go

**Files:**
- Create: `server/cmd/jotctl/cmd/seed.go`

This file contains the full command logic: `runSeed`, `createNote`, `runSeedCmd`, `runResetCmd`, and the cobra `seedCmd`/`resetCmd` variables.

Key behaviours:
- `runSeed` runs in two phases: (1) admin creates all users, collecting IDs; (2) per-user login to upload icon, update settings, and create notes.
- `createNote` handles both text and list notes, applying pinned/archived/`checkedItemsCollapsed` via a follow-up PATCH when needed, and soft-deleting trashed notes after creation.
- Sharing is done after each note is created, using the user-ID map built in phase 1.
- If a seed username already exists the user is warned on stderr and skipped (all their notes are skipped too).
- `runReset` calls `Me()` to identify the current admin, lists all users, deletes every non-admin user, then calls `runSeed`.
- In `--json` mode all progress lines are suppressed and a single JSON summary is emitted.

- [ ] **Step 3.1: Create the file**

```go
// server/cmd/jotctl/cmd/seed.go
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
		fmt.Scanln(&answer) //nolint:errcheck // interactive prompt; partial input is treated as "no"
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
		if u.ID == me.User.ID {
			continue
		}
		if err := jotClient.AdminDeleteUser(cmd.Context(), u.ID); err != nil {
			return wrapAPIError(fmt.Errorf("delete user %s: %w", u.Username, err))
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
func runSeed(ctx context.Context, adminClient *client.Client, jsonOutput bool) (int, int, int, error) {
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
			fmt.Fprintf(os.Stderr, "  ⚠ User %s already exists, skipping\n", u.username)
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
func createNote(ctx context.Context, uc *client.Client, n seedNote) (string, error) {
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
```

- [ ] **Step 3.2: Verify the file compiles**

```bash
cd server && go build ./cmd/jotctl/...
```

Expected: no errors.

- [ ] **Step 3.3: Commit**

```bash
git add server/cmd/jotctl/cmd/seed.go
git commit -m "feat(jotctl): implement seed and reset commands"
```

---

## Task 4: Register commands in root.go

**Files:**
- Modify: `server/cmd/jotctl/cmd/root.go`

Add `seedCmd` and `resetCmd` to the `init()` function alongside the existing commands.

- [ ] **Step 4.1: Open root.go and locate the init function**

The relevant section is at line 41–47:

```go
func init() {
	rootCmd.PersistentFlags().BoolVar(&jsonOutput, "json", false, "Output as JSON")
	rootCmd.AddCommand(loginCmd)
	rootCmd.AddCommand(logoutCmd)
	rootCmd.AddCommand(usersCmd)
	rootCmd.AddCommand(versionCmd)
}
```

- [ ] **Step 4.2: Add seedCmd and resetCmd**

Replace the `init` function body with:

```go
func init() {
	rootCmd.PersistentFlags().BoolVar(&jsonOutput, "json", false, "Output as JSON")
	rootCmd.AddCommand(loginCmd)
	rootCmd.AddCommand(logoutCmd)
	rootCmd.AddCommand(seedCmd)
	rootCmd.AddCommand(resetCmd)
	rootCmd.AddCommand(usersCmd)
	rootCmd.AddCommand(versionCmd)
}
```

- [ ] **Step 4.3: Build to confirm no compile errors**

```bash
cd server && go build ./cmd/jotctl/...
```

Expected: no errors.

- [ ] **Step 4.4: Verify commands appear in help output**

```bash
cd server && go run ./cmd/jotctl/... --help
```

Expected: `seed` and `reset` listed in the commands section.

- [ ] **Step 4.5: Commit**

```bash
git add server/cmd/jotctl/cmd/root.go
git commit -m "feat(jotctl): register seed and reset commands"
```

---

## Task 5: Run tests and lint

- [ ] **Step 5.1: Run full test suite**

```bash
cd /path/to/repo && task test
```

Expected: all tests pass (no new tests to write — the cmd package has no precedent for tests; all underlying HTTP operations are covered by the server integration tests in `server/http_*.go`).

- [ ] **Step 5.2: Run linter**

```bash
task lint
```

Expected: no lint errors.

- [ ] **Step 5.3: Build the jotctl binary**

```bash
task build-jotctl
```

Expected: binary produced at `jotctl` (or configured output path) with no errors.

---

## Dataset Quick-Reference

| User | Notes | Labels | Shared with |
|---|---|---|---|
| alice | 13 (4 active text, 3 active list, 3 archived, 3 trashed) | work, personal, ideas, urgent | bob (3 notes) |
| bob | 3 (active text) | work | — |
| carol | 3 (active text) | — | — |

Total: 19 notes, 3 users.

Alice's shared notes: rich-markdown text note, pinned text note, "Sprint tasks" list note.
