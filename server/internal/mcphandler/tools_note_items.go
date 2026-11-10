package mcphandler

import (
	"context"
	"encoding/json/v2"

	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/notesvc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// registerNoteItemTools adds list-item CRUD tools to srv, all scoped to userID.
//
// Items are managed through dedicated tools rather than through item fields on
// update_note: an AI client edits one item at a time, and a whole-list payload
// on update_note would make every such edit a read-modify-write of the entire
// note, clobbering concurrent changes from other clients.
func (h *Handler) registerNoteItemTools(srv *mcp.Server, userID string) {
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "create_note_item",
		Description: "Add an item to a list note. The item is appended to the end of the list (a child with parent_id: to the end of its parent's group) unless position is given; a child always sorts directly after its parent.",
	}, h.handleCreateNoteItem(userID))

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "update_note_item",
		Description: "Update an item of a list note. Only the provided fields are changed; omitted fields keep their current values.",
	}, h.handleUpdateNoteItem(userID))

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "delete_note_item",
		Description: "Delete an item from a list note.",
	}, h.handleDeleteNoteItem(userID))
}

// -- create_note_item ---------------------------------------------------------

type createNoteItemInput struct {
	NoteID     string `json:"note_id"               jsonschema:"required,Note ID (must be a list note)"`
	Text       string `json:"text"                  jsonschema:"required,Item text"`
	Completed  bool   `json:"completed,omitempty"   jsonschema:"Whether the item starts out checked off (default false)"`
	Position   *int   `json:"position,omitempty"    jsonschema:"Sort position within the list (omit to append to the end)"`
	ParentID   string `json:"parent_id,omitempty"   jsonschema:"Nest this item under a top-level item of the same note (omit for a top-level item)"`
	AssignedTo string `json:"assigned_to,omitempty" jsonschema:"Assign the item to a user: the note owner (user_id) or a collaborator (shared_with[].shared_with_user_id). Only shared notes have assignable items. Omit to leave it unassigned."`
}

func (h *Handler) handleCreateNoteItem(userID string) mcp.ToolHandlerFor[createNoteItemInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in createNoteItemInput) (*mcp.CallToolResult, any, error) {
		if in.NoteID == "" {
			return toolError("note_id is required")
		}
		item, err := h.notes.CreateItem(ctx, in.NoteID, userID, notesvc.NewListItem{
			Text:       in.Text,
			Position:   in.Position,
			Completed:  in.Completed,
			ParentID:   in.ParentID,
			AssignedTo: in.AssignedTo,
		})
		if err != nil {
			return toolError("create note item: %w", err)
		}
		return toolItemResult(item)
	}
}

// -- update_note_item ---------------------------------------------------------

type updateNoteItemInput struct {
	NoteID     string  `json:"note_id"               jsonschema:"required,Note ID (must be a list note)"`
	ItemID     string  `json:"item_id"               jsonschema:"required,Item ID"`
	Text       *string `json:"text,omitempty"        jsonschema:"New item text (omit to keep current)"`
	Completed  *bool   `json:"completed,omitempty"   jsonschema:"Check or uncheck the item (omit to keep current)"`
	Position   *int    `json:"position,omitempty"    jsonschema:"New sort position within the list (omit to keep current)"`
	ParentID   *string `json:"parent_id,omitempty"   jsonschema:"Re-parent the item; an empty string makes it top-level (omit to keep current)"`
	AssignedTo *string `json:"assigned_to,omitempty" jsonschema:"Assign the item to the note owner or a collaborator by user ID; an empty string unassigns it (omit to keep current)"`
}

func (h *Handler) handleUpdateNoteItem(userID string) mcp.ToolHandlerFor[updateNoteItemInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in updateNoteItemInput) (*mcp.CallToolResult, any, error) {
		if in.NoteID == "" {
			return toolError("note_id is required")
		}
		if in.ItemID == "" {
			return toolError("item_id is required")
		}
		item, err := h.notes.PatchItem(ctx, in.NoteID, userID, in.ItemID, models.NoteItemPatch{
			Text:       in.Text,
			Completed:  in.Completed,
			Position:   in.Position,
			ParentID:   in.ParentID,
			AssignedTo: in.AssignedTo,
		})
		if err != nil {
			return toolError("update note item: %w", err)
		}
		return toolItemResult(item)
	}
}

// toolItemResult marshals a list item for a tool result.
func toolItemResult(item *models.NoteItem) (*mcp.CallToolResult, any, error) {
	data, err := json.Marshal(item)
	if err != nil {
		return toolError("marshal note item: %w", err)
	}
	return toolTextResult(data), nil, nil
}

// -- delete_note_item ---------------------------------------------------------

type deleteNoteItemInput struct {
	NoteID string `json:"note_id" jsonschema:"required,Note ID (must be a list note)"`
	ItemID string `json:"item_id" jsonschema:"required,Item ID"`
}

func (h *Handler) handleDeleteNoteItem(userID string) mcp.ToolHandlerFor[deleteNoteItemInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in deleteNoteItemInput) (*mcp.CallToolResult, any, error) {
		if in.NoteID == "" {
			return toolError("note_id is required")
		}
		if in.ItemID == "" {
			return toolError("item_id is required")
		}
		if err := h.notes.DeleteItem(ctx, in.NoteID, userID, in.ItemID); err != nil {
			return toolError("delete note item: %w", err)
		}
		return toolDeletedResult(in.ItemID, map[string]any{"note_id": in.NoteID})
	}
}
