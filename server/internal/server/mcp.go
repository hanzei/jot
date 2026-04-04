package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// buildMCPServer is called by the streamable HTTP handler for each new MCP
// session. It extracts the authenticated user from the request context and
// returns a per-session *mcp.Server whose tools are scoped to that user.
// Returning nil causes the handler to respond with 400 Bad Request.
func (s *Server) buildMCPServer(req *http.Request) *mcp.Server {
	user, ok := auth.GetUserFromContext(req.Context())
	if !ok {
		return nil
	}
	srv := mcp.NewServer(&mcp.Implementation{Name: "jot", Version: version}, nil)
	registerMCPTools(srv, s.noteStore, s.labelStore, user.ID)
	return srv
}

// registerMCPTools adds all note and label CRUD tools to srv.
// Each handler closes over noteStore, labelStore, and userID.
func registerMCPTools(srv *mcp.Server, noteStore *models.NoteStore, labelStore *models.LabelStore, userID string) {
	addListNotesTool(srv, noteStore, userID)
	addGetNoteTool(srv, noteStore, userID)
	addCreateNoteTool(srv, noteStore, userID)
	addUpdateNoteTool(srv, noteStore, userID)
	addDeleteNoteTool(srv, noteStore, userID)
	addListLabelsTool(srv, labelStore, userID)
	addRenameLabelTool(srv, labelStore, userID)
	addDeleteLabelTool(srv, labelStore, userID)
	addLabelToNoteTool(srv, noteStore, labelStore, userID)
	addRemoveLabelFromNoteTool(srv, noteStore, userID)
}

// ── Input types ───────────────────────────────────────────────────────────────

type listNotesInput struct {
	Search   string `json:"search,omitempty"   jsonschema:"Search notes by keyword"`
	Label    string `json:"label,omitempty"    jsonschema:"Filter by label ID"`
	Archived bool   `json:"archived,omitempty" jsonschema:"Include archived notes"`
	Trashed  bool   `json:"trashed,omitempty"  jsonschema:"Include trashed notes"`
}

type getNoteInput struct {
	ID string `json:"id" jsonschema:"ID of the note to retrieve"`
}

type createNoteInput struct {
	Title    string `json:"title,omitempty"     jsonschema:"Note title"`
	Content  string `json:"content,omitempty"   jsonschema:"Note text content"`
	NoteType string `json:"note_type,omitempty" jsonschema:"Note type: 'text' (default) or 'todo'"`
	Color    string `json:"color,omitempty"     jsonschema:"Background color as a hex string (e.g. '#ffffff')"`
}

type updateNoteInput struct {
	ID                    string  `json:"id"                                jsonschema:"ID of the note to update"`
	Title                 *string `json:"title,omitempty"                   jsonschema:"New title"`
	Content               *string `json:"content,omitempty"                 jsonschema:"New text content"`
	Pinned                *bool   `json:"pinned,omitempty"                  jsonschema:"Whether the note is pinned"`
	Archived              *bool   `json:"archived,omitempty"                jsonschema:"Whether the note is archived"`
	Color                 *string `json:"color,omitempty"                   jsonschema:"Background color as a hex string"`
	CheckedItemsCollapsed *bool   `json:"checked_items_collapsed,omitempty" jsonschema:"Whether checked todo items are collapsed"`
}

type deleteNoteInput struct {
	ID        string `json:"id"                  jsonschema:"ID of the note to delete"`
	Permanent bool   `json:"permanent,omitempty" jsonschema:"If true, permanently delete instead of moving to trash"`
}

type listLabelsInput struct{}

type renameLabelInput struct {
	ID   string `json:"id"   jsonschema:"ID of the label to rename"`
	Name string `json:"name" jsonschema:"New label name"`
}

type deleteLabelInput struct {
	ID string `json:"id" jsonschema:"ID of the label to delete"`
}

type addLabelToNoteInput struct {
	NoteID string `json:"note_id" jsonschema:"ID of the note"`
	Name   string `json:"name"    jsonschema:"Label name to add (created if it does not exist)"`
}

type removeLabelFromNoteInput struct {
	NoteID  string `json:"note_id"  jsonschema:"ID of the note"`
	LabelID string `json:"label_id" jsonschema:"ID of the label to remove"`
}

// ── Note tools ────────────────────────────────────────────────────────────────

func addListNotesTool(srv *mcp.Server, noteStore *models.NoteStore, userID string) {
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "list_notes",
		Description: "List notes for the authenticated user. Returns active (non-archived, non-trashed) notes by default.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in listNotesInput) (*mcp.CallToolResult, any, error) {
		notes, err := noteStore.GetByUserID(ctx, userID, in.Archived, in.Trashed, in.Search, in.Label, false)
		if err != nil {
			return nil, nil, fmt.Errorf("list notes: %w", err)
		}
		return jsonResult(notes)
	})
}

func addGetNoteTool(srv *mcp.Server, noteStore *models.NoteStore, userID string) {
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "get_note",
		Description: "Get a single note by ID.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in getNoteInput) (*mcp.CallToolResult, any, error) {
		if in.ID == "" {
			return nil, nil, errors.New("id is required")
		}
		note, err := noteStore.GetByID(ctx, in.ID, userID)
		if err != nil {
			if errors.Is(err, models.ErrNoteNotFound) {
				return nil, nil, fmt.Errorf("note not found: %s", in.ID)
			}
			return nil, nil, fmt.Errorf("get note: %w", err)
		}
		return jsonResult(note)
	})
}

func addCreateNoteTool(srv *mcp.Server, noteStore *models.NoteStore, userID string) {
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "create_note",
		Description: "Create a new note.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in createNoteInput) (*mcp.CallToolResult, any, error) {
		noteType := models.NoteType(in.NoteType)
		if noteType == "" {
			noteType = models.NoteTypeText
		}
		color := in.Color
		if color == "" {
			color = "#ffffff"
		}
		note, err := noteStore.Create(ctx, userID, in.Title, in.Content, noteType, color)
		if err != nil {
			return nil, nil, fmt.Errorf("create note: %w", err)
		}
		return jsonResult(note)
	})
}

func addUpdateNoteTool(srv *mcp.Server, noteStore *models.NoteStore, userID string) {
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "update_note",
		Description: "Partially update a note. Only provided fields are changed.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in updateNoteInput) (*mcp.CallToolResult, any, error) {
		if in.ID == "" {
			return nil, nil, errors.New("id is required")
		}
		err := noteStore.Update(ctx, in.ID, userID, in.Title, in.Content, in.Color, in.Pinned, in.Archived, in.CheckedItemsCollapsed)
		if err != nil {
			if errors.Is(err, models.ErrNoteNotFound) {
				return nil, nil, fmt.Errorf("note not found: %s", in.ID)
			}
			return nil, nil, fmt.Errorf("update note: %w", err)
		}
		note, err := noteStore.GetByID(ctx, in.ID, userID)
		if err != nil {
			return nil, nil, fmt.Errorf("get updated note: %w", err)
		}
		return jsonResult(note)
	})
}

func addDeleteNoteTool(srv *mcp.Server, noteStore *models.NoteStore, userID string) {
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "delete_note",
		Description: "Delete a note. By default moves it to trash; set permanent=true to delete it permanently (note must already be in trash).",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in deleteNoteInput) (*mcp.CallToolResult, any, error) {
		if in.ID == "" {
			return nil, nil, errors.New("id is required")
		}
		if in.Permanent {
			if err := noteStore.DeleteFromTrash(ctx, in.ID, userID); err != nil {
				if errors.Is(err, models.ErrNoteNotInTrash) {
					return nil, nil, fmt.Errorf("note not found in trash: %s", in.ID)
				}
				return nil, nil, fmt.Errorf("delete note permanently: %w", err)
			}
		} else {
			if err := noteStore.MoveToTrash(ctx, in.ID, userID); err != nil {
				if errors.Is(err, models.ErrNoteNotOwnedByUser) {
					return nil, nil, fmt.Errorf("note not found or not owned by user: %s", in.ID)
				}
				return nil, nil, fmt.Errorf("delete note: %w", err)
			}
		}
		return textResult("ok"), nil, nil
	})
}

// ── Label tools ───────────────────────────────────────────────────────────────

func addListLabelsTool(srv *mcp.Server, labelStore *models.LabelStore, userID string) {
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "list_labels",
		Description: "List all labels for the authenticated user.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ listLabelsInput) (*mcp.CallToolResult, any, error) {
		labels, err := labelStore.GetLabels(ctx, userID)
		if err != nil {
			return nil, nil, fmt.Errorf("list labels: %w", err)
		}
		return jsonResult(labels)
	})
}

func addRenameLabelTool(srv *mcp.Server, labelStore *models.LabelStore, userID string) {
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "rename_label",
		Description: "Rename a label.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in renameLabelInput) (*mcp.CallToolResult, any, error) {
		if in.ID == "" {
			return nil, nil, errors.New("id is required")
		}
		if in.Name == "" {
			return nil, nil, errors.New("name is required")
		}
		label, err := labelStore.RenameLabel(ctx, in.ID, userID, in.Name)
		if err != nil {
			if errors.Is(err, models.ErrLabelNotFoundOrNotOwned) {
				return nil, nil, fmt.Errorf("label not found: %s", in.ID)
			}
			if errors.Is(err, models.ErrLabelNameConflict) {
				return nil, nil, fmt.Errorf("label name already exists: %s", in.Name)
			}
			return nil, nil, fmt.Errorf("rename label: %w", err)
		}
		return jsonResult(label)
	})
}

func addDeleteLabelTool(srv *mcp.Server, labelStore *models.LabelStore, userID string) {
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "delete_label",
		Description: "Delete a label and remove it from all notes.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in deleteLabelInput) (*mcp.CallToolResult, any, error) {
		if in.ID == "" {
			return nil, nil, errors.New("id is required")
		}
		if err := labelStore.DeleteLabel(ctx, in.ID, userID); err != nil {
			if errors.Is(err, models.ErrLabelNotFoundOrNotOwned) {
				return nil, nil, fmt.Errorf("label not found: %s", in.ID)
			}
			return nil, nil, fmt.Errorf("delete label: %w", err)
		}
		return textResult("ok"), nil, nil
	})
}

func addLabelToNoteTool(srv *mcp.Server, noteStore *models.NoteStore, labelStore *models.LabelStore, userID string) {
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "add_label_to_note",
		Description: "Add a label to a note by name. Creates the label if it does not already exist.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in addLabelToNoteInput) (*mcp.CallToolResult, any, error) {
		if in.NoteID == "" {
			return nil, nil, errors.New("note_id is required")
		}
		if in.Name == "" {
			return nil, nil, errors.New("name is required")
		}
		label, err := labelStore.GetOrCreateLabel(ctx, userID, in.Name)
		if err != nil {
			return nil, nil, fmt.Errorf("get or create label: %w", err)
		}
		if err = noteStore.AddLabelToNote(ctx, in.NoteID, label.ID, userID); err != nil {
			if errors.Is(err, models.ErrNoteNoAccess) {
				return nil, nil, fmt.Errorf("access denied to note: %s", in.NoteID)
			}
			return nil, nil, fmt.Errorf("add label to note: %w", err)
		}
		note, err := noteStore.GetByID(ctx, in.NoteID, userID)
		if err != nil {
			return nil, nil, fmt.Errorf("get note after adding label: %w", err)
		}
		return jsonResult(note)
	})
}

func addRemoveLabelFromNoteTool(srv *mcp.Server, noteStore *models.NoteStore, userID string) {
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "remove_label_from_note",
		Description: "Remove a label from a note.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in removeLabelFromNoteInput) (*mcp.CallToolResult, any, error) {
		if in.NoteID == "" {
			return nil, nil, errors.New("note_id is required")
		}
		if in.LabelID == "" {
			return nil, nil, errors.New("label_id is required")
		}
		if err := noteStore.RemoveLabelFromNote(ctx, in.NoteID, in.LabelID, userID); err != nil {
			if errors.Is(err, models.ErrNoteNoAccess) {
				return nil, nil, fmt.Errorf("access denied to note: %s", in.NoteID)
			}
			return nil, nil, fmt.Errorf("remove label from note: %w", err)
		}
		note, err := noteStore.GetByID(ctx, in.NoteID, userID)
		if err != nil {
			return nil, nil, fmt.Errorf("get note after removing label: %w", err)
		}
		return jsonResult(note)
	})
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func jsonResult(v any) (*mcp.CallToolResult, any, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal result: %w", err)
	}
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: string(data)}},
	}, nil, nil
}

func textResult(text string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: text}},
	}
}
