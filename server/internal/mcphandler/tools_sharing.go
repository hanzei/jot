package mcphandler

import (
	"cmp"
	"context"
	"encoding/json/v2"
	"errors"

	"github.com/hanzei/jot/server/internal/models"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// registerSharingTools adds the user lookup and note sharing tools to srv, all
// scoped to userID.
func (h *Handler) registerSharingTools(srv *mcp.Server, userID string) {
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "list_users",
		Description: "List the other users on this server, to find the user ID that share_note, unshare_note and a list item's assigned_to need. Pass search to filter by username, first name or last name; a search returns at most 50 matches and sets truncated when there were more.",
	}, h.handleListUsers(userID))

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "share_note",
		Description: "Share a note you own with another user, giving them access to read and edit it. Use list_users to find their user ID.",
	}, h.handleShareNote(userID))

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "unshare_note",
		Description: "Remove a user's access to a note. The note's owner can remove any collaborator. Omit user_id to leave a note someone else shared with you.",
	}, h.handleUnshareNote(userID))
}

// -- list_users ---------------------------------------------------------------

type listUsersInput struct {
	Search string `json:"search,omitempty" jsonschema:"Filter by username, first name or last name (case-insensitive substring match)"`
}

// userResult is a user as list_users returns them: enough to identify the
// person the user means, and the ID the other tools take.
type userResult struct {
	ID        string `json:"id"`
	Username  string `json:"username"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
}

type listUsersResult struct {
	Users     []userResult `json:"users"`
	Truncated bool         `json:"truncated"`
}

func (h *Handler) handleListUsers(userID string) mcp.ToolHandlerFor[listUsersInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in listUsersInput) (*mcp.CallToolResult, any, error) {
		users, truncated, err := h.notes.ListUsers(ctx, userID, in.Search)
		if err != nil {
			return toolError("list users: %w", err)
		}
		result := listUsersResult{Users: make([]userResult, 0, len(users)), Truncated: truncated}
		for _, u := range users {
			result.Users = append(result.Users, userResult{ID: u.ID, Username: u.Username, FirstName: u.FirstName, LastName: u.LastName})
		}
		data, err := json.Marshal(result)
		if err != nil {
			return toolError("marshal users: %w", err)
		}
		return toolTextResult(data), nil, nil
	}
}

// -- share_note ---------------------------------------------------------------

type shareNoteInput struct {
	NoteID string `json:"note_id" jsonschema:"required,Note ID"`
	UserID string `json:"user_id" jsonschema:"required,ID of the user to share with"`
}

func (h *Handler) handleShareNote(userID string) mcp.ToolHandlerFor[shareNoteInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in shareNoteInput) (*mcp.CallToolResult, any, error) {
		if in.NoteID == "" || in.UserID == "" {
			return toolError("note_id and user_id are required")
		}
		if err := h.notes.Share(ctx, in.NoteID, userID, in.UserID); err != nil {
			return toolError("share note: %w", err)
		}
		return toolShareResult(in.NoteID, in.UserID, true)
	}
}

// -- unshare_note -------------------------------------------------------------

type unshareNoteInput struct {
	NoteID string `json:"note_id"           jsonschema:"required,Note ID"`
	UserID string `json:"user_id,omitempty" jsonschema:"ID of the user to remove. Omit to leave the note yourself."`
}

func (h *Handler) handleUnshareNote(userID string) mcp.ToolHandlerFor[unshareNoteInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in unshareNoteInput) (*mcp.CallToolResult, any, error) {
		if in.NoteID == "" {
			return toolError("note_id is required")
		}
		// No tool tells an agent the user's own ID, so leaving is the default.
		target := cmp.Or(in.UserID, userID)
		err := h.notes.Unshare(ctx, in.NoteID, userID, target)
		if in.UserID == "" && errors.Is(err, models.ErrNoteShareNotFound) {
			return toolError("unshare note: this note is not shared with you, so there is nothing to leave. To remove a collaborator from a note you own, pass their user_id")
		}
		if err != nil {
			return toolError("unshare note: %w", err)
		}
		return toolShareResult(in.NoteID, target, false)
	}
}

// toolShareResult confirms a share change: the note, the user, and whether
// they now have access.
func toolShareResult(noteID, userID string, shared bool) (*mcp.CallToolResult, any, error) {
	data, err := json.Marshal(map[string]any{"note_id": noteID, "user_id": userID, "shared": shared})
	if err != nil {
		return toolError("marshal response: %w", err)
	}
	return toolTextResult(data), nil, nil
}
