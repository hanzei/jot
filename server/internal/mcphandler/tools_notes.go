package mcphandler

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/hanzei/jot/server/internal/models"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// registerNoteTools adds note CRUD tools to srv, all scoped to userID.
func (h *Handler) registerNoteTools(srv *mcp.Server, userID string) {
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "list_notes",
		Description: "List notes for the authenticated user. Returns active (non-archived, non-trashed) notes by default. Use the optional parameters to filter the results.",
	}, h.handleListNotes(userID))

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "get_note",
		Description: "Retrieve a single note by its ID.",
	}, h.handleGetNote(userID))

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "create_note",
		Description: "Create a new note. Omit optional fields to use their defaults (empty text note, white background, not pinned).",
	}, h.handleCreateNote(userID))

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "update_note",
		Description: "Update an existing note. Only the provided fields are changed; omitted fields keep their current values.",
	}, h.handleUpdateNote(userID))

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "delete_note",
		Description: "Move a note to the trash. Set permanent to true to permanently delete a note that is already in the trash.",
	}, h.handleDeleteNote(userID))
}

// -- list_notes ---------------------------------------------------------------

type listNotesInput struct {
	Search   string `json:"search,omitempty"   jsonschema:"Search notes by keyword (matches title and content)"`
	Label    string `json:"label,omitempty"    jsonschema:"Filter by label ID"`
	Archived bool   `json:"archived,omitempty" jsonschema:"Include archived notes instead of active notes"`
	Trashed  bool   `json:"trashed,omitempty"  jsonschema:"List notes in the trash instead of active notes"`
}

func (h *Handler) handleListNotes(userID string) mcp.ToolHandlerFor[listNotesInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in listNotesInput) (*mcp.CallToolResult, any, error) {
		notes, err := h.noteStore.GetByUserID(ctx, userID, in.Archived, in.Trashed, in.Search, in.Label, false)
		if err != nil {
			return toolError("list notes: %w", err)
		}
		data, err := json.Marshal(notes)
		if err != nil {
			return toolError("marshal notes: %w", err)
		}
		return toolTextResult(data), nil, nil
	}
}

// -- get_note -----------------------------------------------------------------

type getNoteInput struct {
	ID string `json:"id" jsonschema:"required,Note ID"`
}

func (h *Handler) handleGetNote(userID string) mcp.ToolHandlerFor[getNoteInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in getNoteInput) (*mcp.CallToolResult, any, error) {
		if in.ID == "" {
			return toolError("id is required")
		}
		note, err := h.noteStore.GetByID(ctx, in.ID, userID)
		if err != nil {
			return toolError("get note: %w", err)
		}
		data, err := json.Marshal(note)
		if err != nil {
			return toolError("marshal note: %w", err)
		}
		return toolTextResult(data), nil, nil
	}
}

// -- create_note --------------------------------------------------------------

type createNoteInput struct {
	Title    string           `json:"title,omitempty"     jsonschema:"Note title"`
	Content  string           `json:"content,omitempty"   jsonschema:"Note body text (for text notes)"`
	NoteType models.NoteType  `json:"note_type,omitempty" jsonschema:"Note type: text (default) or todo"`
	Color    string           `json:"color,omitempty"     jsonschema:"Background color as a hex string, e.g. #ffffff"`
}

func (h *Handler) handleCreateNote(userID string) mcp.ToolHandlerFor[createNoteInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in createNoteInput) (*mcp.CallToolResult, any, error) {
		noteType := in.NoteType
		if noteType == "" {
			noteType = models.NoteTypeText
		}
		color := in.Color
		if color == "" {
			color = "#ffffff"
		}
		note, err := h.noteStore.Create(ctx, userID, in.Title, in.Content, noteType, color)
		if err != nil {
			return toolError("create note: %w", err)
		}
		data, err := json.Marshal(note)
		if err != nil {
			return toolError("marshal note: %w", err)
		}
		return toolTextResult(data), nil, nil
	}
}

// -- update_note --------------------------------------------------------------

type updateNoteInput struct {
	ID                    string  `json:"id"                               jsonschema:"required,Note ID"`
	Title                 *string `json:"title,omitempty"                  jsonschema:"New title (omit to keep current)"`
	Content               *string `json:"content,omitempty"                jsonschema:"New body text (omit to keep current)"`
	Pinned                *bool   `json:"pinned,omitempty"                 jsonschema:"Pin or unpin the note (omit to keep current)"`
	Archived              *bool   `json:"archived,omitempty"               jsonschema:"Archive or unarchive the note (omit to keep current)"`
	Color                 *string `json:"color,omitempty"                  jsonschema:"Background color as a hex string (omit to keep current)"`
	CheckedItemsCollapsed *bool   `json:"checked_items_collapsed,omitempty" jsonschema:"Collapse completed todo items (omit to keep current)"`
}

func (h *Handler) handleUpdateNote(userID string) mcp.ToolHandlerFor[updateNoteInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in updateNoteInput) (*mcp.CallToolResult, any, error) {
		if in.ID == "" {
			return toolError("id is required")
		}
		if err := h.noteStore.Update(ctx, in.ID, userID, in.Title, in.Content, in.Color, in.Pinned, in.Archived, in.CheckedItemsCollapsed); err != nil {
			return toolError("update note: %w", err)
		}
		note, err := h.noteStore.GetByID(ctx, in.ID, userID)
		if err != nil {
			return toolError("get updated note: %w", err)
		}
		data, err := json.Marshal(note)
		if err != nil {
			return toolError("marshal note: %w", err)
		}
		return toolTextResult(data), nil, nil
	}
}

// -- delete_note --------------------------------------------------------------

type deleteNoteInput struct {
	ID        string `json:"id"                  jsonschema:"required,Note ID"`
	Permanent bool   `json:"permanent,omitempty" jsonschema:"Set to true to permanently delete a note already in the trash"`
}

func (h *Handler) handleDeleteNote(userID string) mcp.ToolHandlerFor[deleteNoteInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in deleteNoteInput) (*mcp.CallToolResult, any, error) {
		if in.ID == "" {
			return toolError("id is required")
		}
		var err error
		if in.Permanent {
			err = h.noteStore.DeleteFromTrash(ctx, in.ID, userID)
		} else {
			err = h.noteStore.MoveToTrash(ctx, in.ID, userID)
		}
		if err != nil {
			return toolError("delete note: %w", err)
		}
		msg := fmt.Sprintf(`{"id":%q,"deleted":true,"permanent":%v}`, in.ID, in.Permanent)
		return toolTextResult([]byte(msg)), nil, nil
	}
}
