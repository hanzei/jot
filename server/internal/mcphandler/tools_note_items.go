package mcphandler

import (
	"context"
	"encoding/json/v2"
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/hanzei/jot/server/internal/models"
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
		Description: "Add an item to a list note. The item is appended to the end of the list unless position is given.",
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

// loadListNote resolves a note for an item operation. GetByID only returns
// notes the user owns or that are shared with them, so it doubles as the
// access check; the note must also be a list.
func (h *Handler) loadListNote(ctx context.Context, noteID, userID string) (*models.Note, error) {
	if noteID == "" {
		return nil, errors.New("note_id is required")
	}
	note, err := h.noteStore.GetByID(ctx, noteID, userID)
	if err != nil {
		return nil, fmt.Errorf("get note: %w", err)
	}
	if note.NoteType != models.NoteTypeList {
		return nil, errors.New("items can only be modified on list notes")
	}
	return note, nil
}

// validateItemText enforces the per-item text limit shared with the REST API.
func validateItemText(text string) error {
	if utf8.RuneCountInString(text) > models.NoteItemTextMaxLength {
		return fmt.Errorf("item text must be %d characters or fewer", models.NoteItemTextMaxLength)
	}
	return nil
}

// errItemCapExceeded is the message both cap paths report — the pre-check in
// buildCreateNoteItems and the store's atomic check — kept in one place so they
// cannot drift. It matches the wording the REST API returns.
func errItemCapExceeded() error {
	return fmt.Errorf("note cannot have more than %d items", models.NoteItemsMaxCount)
}

// itemCapError translates the store's cap sentinel into that message, so both
// surfaces describe the limit identically.
func itemCapError(err error) error {
	if errors.Is(err, models.ErrNoteItemCapExceeded) {
		return errItemCapExceeded()
	}
	return err
}

// nextItemPosition returns the position that appends an item to the end of the
// note's current list.
func nextItemPosition(note *models.Note) int {
	next := 0
	for _, item := range note.Items {
		if item.Position >= next {
			next = item.Position + 1
		}
	}
	return next
}

// buildCreateNoteItems validates the items supplied to create_note and resolves
// them into store items. Slice order is the display order, so positions are
// assigned by index; every item is top-level.
func buildCreateNoteItems(specs []createNoteItemSpec) ([]models.NewNoteItem, error) {
	if len(specs) == 0 {
		return nil, nil
	}
	if len(specs) > models.NoteItemsMaxCount {
		return nil, errItemCapExceeded()
	}
	items := make([]models.NewNoteItem, 0, len(specs))
	for i, spec := range specs {
		if err := validateItemText(spec.Text); err != nil {
			return nil, fmt.Errorf("item %d: %w", i, err)
		}
		items = append(items, models.NewNoteItem{
			Text:      spec.Text,
			Position:  i,
			Completed: spec.Completed,
		})
	}
	return items, nil
}

// -- create_note_item ---------------------------------------------------------

type createNoteItemInput struct {
	NoteID    string `json:"note_id"             jsonschema:"required,Note ID (must be a list note)"`
	Text      string `json:"text"                jsonschema:"required,Item text"`
	Completed bool   `json:"completed,omitempty" jsonschema:"Whether the item starts out checked off (default false)"`
	Position  *int   `json:"position,omitempty"  jsonschema:"Sort position within the list (omit to append to the end)"`
	ParentID  string `json:"parent_id,omitempty" jsonschema:"Nest this item under a top-level item of the same note (omit for a top-level item)"`
}

func (h *Handler) handleCreateNoteItem(userID string) mcp.ToolHandlerFor[createNoteItemInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in createNoteItemInput) (*mcp.CallToolResult, any, error) {
		note, err := h.loadListNote(ctx, in.NoteID, userID)
		if err != nil {
			return toolError("%w", err)
		}
		if err = validateItemText(in.Text); err != nil {
			return toolError("%w", err)
		}

		position := nextItemPosition(note)
		if in.Position != nil {
			position = *in.Position
		}

		// CreateItemWithID does not generate an ID for an empty string, so the
		// caller must supply one.
		itemID, err := models.GenerateID()
		if err != nil {
			return toolError("generate item ID: %w", err)
		}

		// The cap is enforced atomically inside the create transaction, so a
		// pre-check here would only race.
		item, err := h.noteStore.CreateItemWithID(ctx, in.NoteID, itemID, in.Text, position, in.Completed, in.ParentID, "", models.NoteItemsMaxCount)
		if err != nil {
			return toolError("create note item: %w", itemCapError(err))
		}
		data, err := json.Marshal(item)
		if err != nil {
			return toolError("marshal note item: %w", err)
		}
		return toolTextResult(data), nil, nil
	}
}

// -- update_note_item ---------------------------------------------------------

type updateNoteItemInput struct {
	NoteID    string  `json:"note_id"             jsonschema:"required,Note ID (must be a list note)"`
	ItemID    string  `json:"item_id"             jsonschema:"required,Item ID"`
	Text      *string `json:"text,omitempty"      jsonschema:"New item text (omit to keep current)"`
	Completed *bool   `json:"completed,omitempty" jsonschema:"Check or uncheck the item (omit to keep current)"`
	Position  *int    `json:"position,omitempty"  jsonschema:"New sort position within the list (omit to keep current)"`
	ParentID  *string `json:"parent_id,omitempty" jsonschema:"Re-parent the item; an empty string makes it top-level (omit to keep current)"`
}

func (h *Handler) handleUpdateNoteItem(userID string) mcp.ToolHandlerFor[updateNoteItemInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in updateNoteItemInput) (*mcp.CallToolResult, any, error) {
		if _, err := h.loadListNote(ctx, in.NoteID, userID); err != nil {
			return toolError("%w", err)
		}
		if in.ItemID == "" {
			return toolError("item_id is required")
		}
		if in.Text != nil {
			if err := validateItemText(*in.Text); err != nil {
				return toolError("%w", err)
			}
		}

		item, err := h.noteStore.PatchItem(ctx, in.NoteID, in.ItemID, models.NoteItemPatch{
			Text:      in.Text,
			Completed: in.Completed,
			Position:  in.Position,
			ParentID:  in.ParentID,
		})
		if err != nil {
			return toolError("update note item: %w", err)
		}
		data, err := json.Marshal(item)
		if err != nil {
			return toolError("marshal note item: %w", err)
		}
		return toolTextResult(data), nil, nil
	}
}

// -- delete_note_item ---------------------------------------------------------

type deleteNoteItemInput struct {
	NoteID string `json:"note_id" jsonschema:"required,Note ID (must be a list note)"`
	ItemID string `json:"item_id" jsonschema:"required,Item ID"`
}

func (h *Handler) handleDeleteNoteItem(userID string) mcp.ToolHandlerFor[deleteNoteItemInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in deleteNoteItemInput) (*mcp.CallToolResult, any, error) {
		if _, err := h.loadListNote(ctx, in.NoteID, userID); err != nil {
			return toolError("%w", err)
		}
		if in.ItemID == "" {
			return toolError("item_id is required")
		}
		if err := h.noteStore.DeleteItemFromNote(ctx, in.NoteID, in.ItemID); err != nil {
			return toolError("delete note item: %w", err)
		}
		return toolDeletedResult(in.ItemID, map[string]any{"note_id": in.NoteID})
	}
}
