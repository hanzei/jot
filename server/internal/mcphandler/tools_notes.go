package mcphandler

import (
	"context"
	"encoding/json/v2"
	"fmt"

	"github.com/hanzei/jot/server/internal/blobstore"
	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/sse"
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
		Description: "Create a new note. Omit optional fields to use their defaults (empty text note, white background, not pinned). Text notes have content but no title; list notes have a title and items but no content. Supplying items creates a list note; use the note item tools to change them afterwards.",
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
	Items []createNoteItemSpec `json:"items,omitempty" jsonschema:"List items in display order. Implies note_type list."`
}

func (h *Handler) handleCreateNote(userID string) mcp.ToolHandlerFor[createNoteInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in createNoteInput) (*mcp.CallToolResult, any, error) {
		noteType, color, err := resolveCreateNote(in)
		if err != nil {
			return toolError("%w", err)
		}

		items, err := buildCreateNoteItems(in.Items)
		if err != nil {
			return toolError("%w", err)
		}

		note, err := h.noteStore.CreateWithItems(ctx, userID, "", in.Title, in.Content, noteType, color, items)
		if err != nil {
			return toolError("create note: %w", itemCapError(err))
		}

		// CreateWithItems builds its return value from the arguments and does
		// not read the inserted items back, so refetch to return the note with
		// its items (and their generated IDs) — the same thing the REST API does.
		if len(items) > 0 {
			note, err = h.noteStore.GetByID(ctx, note.ID, userID)
			if err != nil {
				return toolError("get created note: %w", err)
			}
		}

		h.events.NoteToAudience(ctx, note.ID, sse.EventNoteCreated, models.SanitizeNote(*note), userID)
		return toolNoteResult(note)
	}
}

// resolveCreateNote fills in create_note's defaults (type, color) and applies
// the field rules shared with the REST API.
func resolveCreateNote(in createNoteInput) (models.NoteType, string, error) {
	// Items only exist on list notes, so they imply the type — matching the
	// REST API, which defaults note_type to list when items are supplied.
	noteType := in.NoteType
	switch {
	case len(in.Items) > 0 && noteType == "":
		noteType = models.NoteTypeList
	case len(in.Items) > 0 && noteType != models.NoteTypeList:
		return "", "", fmt.Errorf("note_type must be %q when items are provided", models.NoteTypeList)
	case noteType == "":
		noteType = models.NoteTypeText
	}
	if !noteType.Valid() {
		return "", "", fmt.Errorf("note_type must be %q or %q", models.NoteTypeText, models.NoteTypeList)
	}

	color := in.Color
	if color == "" {
		color = models.DefaultNoteColor
	}
	if err := validateNoteFields(&in.Title, &in.Content, &color); err != nil {
		return "", "", err
	}
	if err := models.ValidateNoteTypeFields(noteType, &in.Title, &in.Content, nil); err != nil {
		return "", "", err
	}
	return noteType, color, nil
}

// validateNoteFields applies the note field limits shared with the REST API.
// A nil pointer is a field the caller is not setting.
func validateNoteFields(title, content, color *string) error {
	if title != nil {
		if err := models.ValidateNoteTitle(*title); err != nil {
			return err
		}
	}
	if content != nil {
		if err := models.ValidateNoteContent(*content); err != nil {
			return err
		}
	}
	if color != nil {
		if err := models.ValidateNoteColor(*color); err != nil {
			return err
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
}

func (h *Handler) handleUpdateNote(userID string) mcp.ToolHandlerFor[updateNoteInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in updateNoteInput) (*mcp.CallToolResult, any, error) {
		if in.ID == "" {
			return toolError("id is required")
		}
		// An empty color resets to the default, as in the REST API.
		if in.Color != nil && *in.Color == "" {
			def := models.DefaultNoteColor
			in.Color = &def
		}
		if err := validateNoteFields(in.Title, in.Content, in.Color); err != nil {
			return toolError("%w", err)
		}
		current, err := h.noteStore.GetByID(ctx, in.ID, userID)
		if err != nil {
			return toolError("get note: %w", err)
		}
		if err = models.ValidateNoteTypeFields(current.NoteType, in.Title, in.Content, in.CheckedItemsCollapsed); err != nil {
			return toolError("%w", err)
		}

		if err = h.noteStore.Update(ctx, in.ID, userID, in.Title, in.Content, in.Color, in.Pinned, in.Archived, in.CheckedItemsCollapsed, nil); err != nil {
			return toolError("update note: %w", err)
		}
		note, err := h.noteStore.GetByID(ctx, in.ID, userID)
		if err != nil {
			return toolError("get updated note: %w", err)
		}

		// Title and content are shared with collaborators; the other fields
		// are per-user, so only the caller's own sessions need to hear of them.
		h.events.NoteUpdated(ctx, in.ID, note, userID, in.Title != nil || in.Content != nil)
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
		// Resolve the audience before deleting, while the shares still exist.
		audienceIDs, audienceErr := h.noteStore.GetNoteAudienceIDs(ctx, in.ID)

		if in.Permanent {
			shas, err := h.noteStore.DeleteFromTrash(ctx, in.ID, userID)
			if err != nil {
				return toolError("delete note: %w", err)
			}
			h.reclaimNoteImageBlobs(ctx, shas)
		} else {
			if err := h.noteStore.MoveToTrash(ctx, in.ID, userID); err != nil {
				return toolError("delete note: %w", err)
			}
		}
		if audienceErr == nil {
			h.events.NoteDeleted(ctx, in.ID, audienceIDs, userID)
		}
		return toolDeletedResult(in.ID, map[string]any{"permanent": in.Permanent})
	}
}

// reclaimNoteImageBlobs reclaims the on-disk blob (and derived thumbnail) for
// each sha whose note_images refcount has hit zero, mirroring the HTTP
// delete_note handler's blob cleanup (docs/specs/file-attachments.md §10).
// Errors are logged but never fail the tool call — the note delete already
// succeeded. Uses context.WithoutCancel since the row delete already
// committed: an MCP client disconnecting must not abort this cleanup and
// leak the blob, as there's no retry path for it afterward.
func (h *Handler) reclaimNoteImageBlobs(ctx context.Context, shas []string) {
	ctx = context.WithoutCancel(ctx)
	for _, sha := range shas {
		if err := blobstore.ReclaimIfOrphaned(ctx, h.noteStore, h.imageStore, sha); err != nil {
			logutil.FromContext(ctx).WithError(err).WithField("sha256", sha).Error("Failed to reclaim orphaned note image blob/thumbnail")
		}
	}
}
