package mcphandler

import (
	"context"
	"encoding/json"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// registerLabelTools adds label CRUD tools to srv, all scoped to userID.
func (h *Handler) registerLabelTools(srv *mcp.Server, userID string) {
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "list_labels",
		Description: "List all labels belonging to the authenticated user.",
	}, h.handleListLabels(userID))

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "rename_label",
		Description: "Rename an existing label.",
	}, h.handleRenameLabel(userID))

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "delete_label",
		Description: "Delete a label and remove it from all notes it is attached to.",
	}, h.handleDeleteLabel(userID))

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "add_label_to_note",
		Description: "Add a label to a note by name. Creates the label if it does not already exist.",
	}, h.handleAddLabelToNote(userID))

	mcp.AddTool(srv, &mcp.Tool{
		Name:        "remove_label_from_note",
		Description: "Remove a label from a note.",
	}, h.handleRemoveLabelFromNote(userID))
}

// -- list_labels --------------------------------------------------------------

type listLabelsInput struct{}

func (h *Handler) handleListLabels(userID string) mcp.ToolHandlerFor[listLabelsInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, _ listLabelsInput) (*mcp.CallToolResult, any, error) {
		labels, err := h.labelStore.GetLabels(ctx, userID)
		if err != nil {
			return toolError("list labels: %w", err)
		}
		data, err := json.Marshal(labels)
		if err != nil {
			return toolError("marshal labels: %w", err)
		}
		return toolTextResult(data), nil, nil
	}
}

// -- rename_label -------------------------------------------------------------

type renameLabelInput struct {
	ID   string `json:"id"   jsonschema:"required,Label ID"`
	Name string `json:"name" jsonschema:"required,New label name"`
}

func (h *Handler) handleRenameLabel(userID string) mcp.ToolHandlerFor[renameLabelInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in renameLabelInput) (*mcp.CallToolResult, any, error) {
		if in.ID == "" {
			return toolError("id is required")
		}
		if in.Name == "" {
			return toolError("name is required")
		}
		label, err := h.labelStore.RenameLabel(ctx, in.ID, userID, in.Name)
		if err != nil {
			return toolError("rename label: %w", err)
		}
		data, err := json.Marshal(label)
		if err != nil {
			return toolError("marshal label: %w", err)
		}
		return toolTextResult(data), nil, nil
	}
}

// -- delete_label -------------------------------------------------------------

type deleteLabelInput struct {
	ID string `json:"id" jsonschema:"required,Label ID"`
}

func (h *Handler) handleDeleteLabel(userID string) mcp.ToolHandlerFor[deleteLabelInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in deleteLabelInput) (*mcp.CallToolResult, any, error) {
		if in.ID == "" {
			return toolError("id is required")
		}
		if err := h.labelStore.DeleteLabel(ctx, in.ID, userID); err != nil {
			return toolError("delete label: %w", err)
		}
		data, err := json.Marshal(map[string]any{"id": in.ID, "deleted": true})
		if err != nil {
			return toolError("marshal response: %w", err)
		}
		return toolTextResult(data), nil, nil
	}
}

// -- add_label_to_note --------------------------------------------------------

type addLabelToNoteInput struct {
	NoteID string `json:"note_id" jsonschema:"required,Note ID"`
	Name   string `json:"name"    jsonschema:"required,Label name (created if it does not exist)"`
}

func (h *Handler) handleAddLabelToNote(userID string) mcp.ToolHandlerFor[addLabelToNoteInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in addLabelToNoteInput) (*mcp.CallToolResult, any, error) {
		if in.NoteID == "" {
			return toolError("note_id is required")
		}
		if in.Name == "" {
			return toolError("name is required")
		}
		label, err := h.labelStore.GetOrCreateLabel(ctx, userID, in.Name)
		if err != nil {
			return toolError("get or create label: %w", err)
		}
		if err = h.noteStore.AddLabelToNote(ctx, in.NoteID, label.ID, userID); err != nil {
			return toolError("add label to note: %w", err)
		}
		note, err := h.noteStore.GetByID(ctx, in.NoteID, userID)
		if err != nil {
			return toolError("get note after label add: %w", err)
		}
		data, err := json.Marshal(note)
		if err != nil {
			return toolError("marshal note: %w", err)
		}
		return toolTextResult(data), nil, nil
	}
}

// -- remove_label_from_note ---------------------------------------------------

type removeLabelFromNoteInput struct {
	NoteID  string `json:"note_id"  jsonschema:"required,Note ID"`
	LabelID string `json:"label_id" jsonschema:"required,Label ID"`
}

func (h *Handler) handleRemoveLabelFromNote(userID string) mcp.ToolHandlerFor[removeLabelFromNoteInput, any] {
	return func(ctx context.Context, _ *mcp.CallToolRequest, in removeLabelFromNoteInput) (*mcp.CallToolResult, any, error) {
		if in.NoteID == "" {
			return toolError("note_id is required")
		}
		if in.LabelID == "" {
			return toolError("label_id is required")
		}
		if err := h.noteStore.RemoveLabelFromNote(ctx, in.NoteID, in.LabelID, userID); err != nil {
			return toolError("remove label from note: %w", err)
		}
		note, err := h.noteStore.GetByID(ctx, in.NoteID, userID)
		if err != nil {
			return toolError("get note after label remove: %w", err)
		}
		data, err := json.Marshal(note)
		if err != nil {
			return toolError("marshal note: %w", err)
		}
		return toolTextResult(data), nil, nil
	}
}
