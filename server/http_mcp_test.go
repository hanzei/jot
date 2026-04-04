package main

import (
	"encoding/json"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// setupMCPSession connects an MCP client to the test server, authenticated as tu.
func setupMCPSession(t *testing.T, ts *TestServer, tu *TestUser) *mcp.ClientSession {
	t.Helper()
	c := mcp.NewClient(&mcp.Implementation{Name: "test-client"}, nil)
	transport := &mcp.StreamableClientTransport{
		Endpoint:             ts.HTTPServer.URL + "/api/v1/mcp",
		HTTPClient:           tu.Client.HTTPClient(),
		DisableStandaloneSSE: true,
	}
	sess, err := c.Connect(t.Context(), transport, nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = sess.Close() })
	return sess
}

// callTool calls a named MCP tool and decodes the text content into dst.
func callTool(t *testing.T, sess *mcp.ClientSession, name string, args any, dst any) {
	t.Helper()
	result, err := sess.CallTool(t.Context(), &mcp.CallToolParams{
		Name:      name,
		Arguments: args,
	})
	require.NoError(t, err)
	require.False(t, result.IsError, "tool returned an error: %v", result.Content)
	require.NotEmpty(t, result.Content)
	text, ok := result.Content[0].(*mcp.TextContent)
	require.True(t, ok, "expected TextContent, got %T", result.Content[0])
	if dst != nil {
		require.NoError(t, json.Unmarshal([]byte(text.Text), dst))
	}
}

func TestMCPListNotes(t *testing.T) {
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpuser", "password", false)
	sess := setupMCPSession(t, ts, tu)

	var notes []client.Note
	callTool(t, sess, "list_notes", map[string]any{}, &notes)
	assert.Empty(t, notes)
}

func TestMCPCreateAndGetNote(t *testing.T) {
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpuser2", "password", false)
	sess := setupMCPSession(t, ts, tu)

	var created client.Note
	callTool(t, sess, "create_note", map[string]any{
		"title":   "Hello MCP",
		"content": "Created via MCP",
	}, &created)

	assert.Equal(t, "Hello MCP", created.Title)
	assert.Equal(t, "Created via MCP", created.Content)
	assert.NotEmpty(t, created.ID)

	var fetched client.Note
	callTool(t, sess, "get_note", map[string]any{"id": created.ID}, &fetched)
	assert.Equal(t, created.ID, fetched.ID)
	assert.Equal(t, "Hello MCP", fetched.Title)
}

func TestMCPUpdateNote(t *testing.T) {
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpuser3", "password", false)
	sess := setupMCPSession(t, ts, tu)

	var created client.Note
	callTool(t, sess, "create_note", map[string]any{"title": "Before"}, &created)

	newTitle := "After"
	var updated client.Note
	callTool(t, sess, "update_note", map[string]any{
		"id":    created.ID,
		"title": newTitle,
	}, &updated)
	assert.Equal(t, "After", updated.Title)

	var fetched client.Note
	callTool(t, sess, "get_note", map[string]any{"id": created.ID}, &fetched)
	assert.Equal(t, "After", fetched.Title)
}

func TestMCPDeleteNote(t *testing.T) {
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpuser4", "password", false)
	sess := setupMCPSession(t, ts, tu)

	var created client.Note
	callTool(t, sess, "create_note", map[string]any{"title": "To delete"}, &created)

	callTool(t, sess, "delete_note", map[string]any{"id": created.ID}, nil)

	// Active notes should be empty; the note is in trash.
	var notes []client.Note
	callTool(t, sess, "list_notes", map[string]any{}, &notes)
	assert.Empty(t, notes)

	// Trashed notes should contain it.
	var trashed []client.Note
	callTool(t, sess, "list_notes", map[string]any{"trashed": true}, &trashed)
	require.Len(t, trashed, 1)
	assert.Equal(t, created.ID, trashed[0].ID)
}

func TestMCPLabelCRUD(t *testing.T) {
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpuser5", "password", false)
	sess := setupMCPSession(t, ts, tu)

	// Initially no labels.
	var labels []client.Label
	callTool(t, sess, "list_labels", map[string]any{}, &labels)
	assert.Empty(t, labels)

	// Create a note, then add a label.
	var note client.Note
	callTool(t, sess, "create_note", map[string]any{"title": "Labeled note"}, &note)

	var noteWithLabel client.Note
	callTool(t, sess, "add_label_to_note", map[string]any{
		"note_id": note.ID,
		"name":    "work",
	}, &noteWithLabel)
	require.Len(t, noteWithLabel.Labels, 1)
	assert.Equal(t, "work", noteWithLabel.Labels[0].Name)
	labelID := noteWithLabel.Labels[0].ID

	// The label should now appear in list_labels.
	callTool(t, sess, "list_labels", map[string]any{}, &labels)
	require.Len(t, labels, 1)
	assert.Equal(t, "work", labels[0].Name)

	// Rename it.
	var renamed client.Label
	callTool(t, sess, "rename_label", map[string]any{"id": labelID, "name": "personal"}, &renamed)
	assert.Equal(t, "personal", renamed.Name)

	// Remove it from the note.
	var noteWithoutLabel client.Note
	callTool(t, sess, "remove_label_from_note", map[string]any{
		"note_id":  note.ID,
		"label_id": labelID,
	}, &noteWithoutLabel)
	assert.Empty(t, noteWithoutLabel.Labels)

	// Delete the label.
	callTool(t, sess, "delete_label", map[string]any{"id": labelID}, nil)
	callTool(t, sess, "list_labels", map[string]any{}, &labels)
	assert.Empty(t, labels)
}

func TestMCPUnauthenticated(t *testing.T) {
	ts := setupTestServer(t)

	// Connect without a session cookie.
	c := mcp.NewClient(&mcp.Implementation{Name: "unauth-client"}, nil)
	transport := &mcp.StreamableClientTransport{
		Endpoint:             ts.HTTPServer.URL + "/api/v1/mcp",
		DisableStandaloneSSE: true,
	}
	_, err := c.Connect(t.Context(), transport, nil)
	require.Error(t, err, "expected connection to fail without authentication")
}
