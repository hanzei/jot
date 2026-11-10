package mcphandler

import (
	"context"
	"encoding/json/v2"
	"errors"
	"fmt"

	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/notesvc"
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
		Description: "Create a new note. Omit optional fields to use their defaults (empty text note, white background, not pinned, no labels). Text notes have content but no title; list notes have a title and items but no content. Supplying items creates a list note; use the note item tools to change them afterwards.",
	}, h.handleCreateNote(userID))

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "update_note",
		Description: "Update an existing note. Only the provided fields are changed; omitted fields keep their current values. When changing title or content, pass the note's version as base_version so a newer edit by a collaborator is not overwritten.",
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
	MyTasks  bool   `json:"my_tasks,omitempty" jsonschema:"List only notes with list items assigned to the authenticated user, archived or not (archived is ignored; trashed takes precedence)"`
}

func (h *Handler) handleListNotes(userID string) mcp.ToolHandlerFor[listNotesInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in listNotesInput) (*mcp.CallToolResult, any, error) {
		// Search is a full-text scan, rate-limited like GET /notes?search=.
		if in.Search != "" {
			allowed, err := h.allowExpensive(ctx, userID)
			if err != nil {
				return toolError("list notes: %w", err)
			}
			if !allowed {
				return toolError("list notes: too many searches; wait a minute before searching again")
			}
		}
		notes, err := h.noteStore.GetByUserID(ctx, userID, models.NoteFilter{
			Archived: in.Archived,
			Trashed:  in.Trashed,
			MyTasks:  in.MyTasks,
			Search:   in.Search,
			LabelID:  in.Label,
		})
		if err != nil {
			return toolError("list notes: %w", err)
		}
		data, err := json.Marshal(models.SanitizeNotes(notes))
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
		return toolNoteResult(note)
	}
}

// -- create_note --------------------------------------------------------------

// createNoteItemSpec is one list item supplied to create_note. It deliberately
// carries no ID or parent: IDs are server-generated, and nesting is applied
// afterwards with update_note_item, which can reference the created item IDs.
type createNoteItemSpec struct {
	Text      string `json:"text"                jsonschema:"required,Item text"`
	Completed bool   `json:"completed,omitempty" jsonschema:"Whether the item starts out checked off (default false)"`
}

type createNoteInput struct {
	Title    string          `json:"title,omitempty"     jsonschema:"Note title (for list notes)"`
	Content  string          `json:"content,omitempty"   jsonschema:"Note body text (for text notes)"`
	NoteType models.NoteType `json:"note_type,omitempty" jsonschema:"Note type: text (default) or list"`
	Color    string          `json:"color,omitempty"     jsonschema:"Background color as a hex string, e.g. #ffffff"`
	// Items is ordered: the first entry becomes the first list item.
	Items  []createNoteItemSpec `json:"items,omitempty"  jsonschema:"List items in display order. Implies note_type list."`
	Labels []string             `json:"labels,omitempty" jsonschema:"Label names to attach. Labels that do not exist yet are created."`
	Pinned bool                 `json:"pinned,omitempty" jsonschema:"Create the note pinned (default false)"`
}

func (h *Handler) handleCreateNote(userID string) mcp.ToolHandlerFor[createNoteInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in createNoteInput) (*mcp.CallToolResult, any, error) {
		// Slice order is the display order, and every item is top-level.
		items := make([]notesvc.NewItem, len(in.Items))
		for i, spec := range in.Items {
			items[i] = notesvc.NewItem{Text: spec.Text, Position: i, Completed: spec.Completed}
		}
		note, err := h.notes.Create(ctx, userID, notesvc.NewNote{
			Title:   in.Title,
			Content: in.Content,
			Type:    in.NoteType,
			Color:   in.Color,
			Items:   items,
			Labels:  in.Labels,
			Pinned:  in.Pinned,
		})
		if err != nil {
			return toolError("create note: %w", err)
		}
		return toolNoteResult(note)
	}
}

// attachLabels attaches the caller's labels with the given names to noteID,
// creating the ones that do not exist yet. Names that differ only in case
// resolve to the same label, and attaching it twice is a no-op.
func (h *Handler) attachLabels(ctx context.Context, noteID, userID string, names []string) error {
	for _, name := range names {
		label, _, err := h.labelStore.GetOrCreateLabel(ctx, userID, name)
		if err != nil {
			return fmt.Errorf("get or create label %q: %w", name, err)
		}
		if err = h.noteStore.AddLabelToNote(ctx, noteID, label.ID, userID); err != nil {
			return fmt.Errorf("add label to note: %w", err)
		}
	}
	return nil
}

// -- update_note --------------------------------------------------------------

type updateNoteInput struct {
	ID                    string  `json:"id"                               jsonschema:"required,Note ID"`
	Title                 *string `json:"title,omitempty"                  jsonschema:"New title (omit to keep current)"`
	Content               *string `json:"content,omitempty"                jsonschema:"New body text (omit to keep current)"`
	Pinned                *bool   `json:"pinned,omitempty"                 jsonschema:"Pin or unpin the note (omit to keep current)"`
	Archived              *bool   `json:"archived,omitempty"               jsonschema:"Archive or unarchive the note (omit to keep current)"`
	Color                 *string `json:"color,omitempty"                  jsonschema:"Background color as a hex string (omit to keep current)"`
	CheckedItemsCollapsed *bool   `json:"checked_items_collapsed,omitempty" jsonschema:"Collapse completed list items (omit to keep current)"`
	BaseVersion           *int    `json:"base_version,omitempty"           jsonschema:"The note's version when you read it. A title or content change is rejected if the note has changed since. Omit to overwrite unconditionally."`
}

func (h *Handler) handleUpdateNote(userID string) mcp.ToolHandlerFor[updateNoteInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in updateNoteInput) (*mcp.CallToolResult, any, error) {
		if in.ID == "" {
			return toolError("id is required")
		}
		note, err := h.notes.Update(ctx, in.ID, userID, models.NoteUpdate{
			Title:                 in.Title,
			Content:               in.Content,
			Color:                 in.Color,
			Pinned:                in.Pinned,
			Archived:              in.Archived,
			CheckedItemsCollapsed: in.CheckedItemsCollapsed,
			BaseVersion:           in.BaseVersion,
		})
		if errors.Is(err, models.ErrNoteVersionConflict) {
			return toolError("update note: the note has changed since version %d; nothing was updated. Call get_note to read the current version, then reapply your change", *in.BaseVersion)
		}
		if err != nil {
			return toolError("update note: %w", err)
		}
		return toolNoteResult(note)
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
		if err := h.notes.Delete(ctx, in.ID, userID, in.Permanent); err != nil {
			return toolError("delete note: %w", err)
		}
		return toolDeletedResult(in.ID, map[string]any{"permanent": in.Permanent})
	}
}
