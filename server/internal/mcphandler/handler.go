// Package mcphandler implements the Jot MCP server, exposing note and label
// CRUD operations as Model Context Protocol tools over the streamable-HTTP
// transport. It is designed to be mounted by the main HTTP server.
package mcphandler

import (
	"fmt"
	"net/http"

	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Handler exposes Jot note and label operations as MCP tools.
type Handler struct {
	noteStore  *models.NoteStore
	labelStore *models.LabelStore
}

// New creates a new Handler backed by the provided stores.
func New(noteStore *models.NoteStore, labelStore *models.LabelStore) *Handler {
	return &Handler{
		noteStore:  noteStore,
		labelStore: labelStore,
	}
}

// NewStreamableHTTPHandler returns an [http.Handler] that serves the MCP
// streamable-HTTP transport. Each new MCP session receives its own
// [mcp.Server] scoped to the authenticated user extracted from the request
// context. A nil return from buildServer causes the SDK to respond with
// 400 Bad Request, which guards against unauthenticated connections.
//
// Callers must mount this handler behind the auth middleware so the request
// context already carries a valid user when this handler is invoked.
func (h *Handler) NewStreamableHTTPHandler() http.Handler {
	return mcp.NewStreamableHTTPHandler(h.buildServer, &mcp.StreamableHTTPOptions{
		// Disable the SDK's built-in localhost-protection check. The Jot HTTP
		// server applies its own cross-origin and CORS protection via middleware
		// before this handler is reached, so adding a second layer would be
		// redundant and could interfere with legitimate cross-origin requests
		// that have already been validated.
		DisableLocalhostProtection: true,
	})
}

// buildServer is called by the streamable HTTP handler for each new MCP
// session. It creates a per-session [mcp.Server] with tools scoped to the
// authenticated user.
func (h *Handler) buildServer(req *http.Request) *mcp.Server {
	user, ok := auth.GetUserFromContext(req.Context())
	if !ok {
		// Returning nil causes the SDK to respond with 400 Bad Request.
		return nil
	}

	srv := mcp.NewServer(&mcp.Implementation{Name: "jot"}, nil)
	h.registerNoteTools(srv, user.ID)
	h.registerLabelTools(srv, user.ID)
	return srv
}

// toolTextResult wraps a JSON-marshaled value as a single text MCP result.
func toolTextResult(data []byte) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: string(data)}},
	}
}

// toolError returns a tool-level error from a [mcp.ToolHandlerFor] handler.
//
// Its return signature matches [mcp.ToolHandlerFor]: (*CallToolResult, Out, error).
// Returning a non-nil error from a ToolHandlerFor handler is treated by the
// SDK as a tool execution failure, not a protocol error — the SDK sets
// CallToolResult.IsError to true and surfaces the error message to the model.
// This is distinct from a protocol error, which would abort the MCP session.
func toolError(format string, args ...any) (*mcp.CallToolResult, any, error) {
	return nil, nil, fmt.Errorf(format, args...)
}
