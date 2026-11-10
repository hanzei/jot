package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/sse"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// setupMCPSession connects an MCP client to the test server, authenticated as tu.
func setupMCPSession(t *testing.T, ts *TestServer, tu *TestUser) *mcp.ClientSession {
	t.Helper()
	return connectMCP(t, ts, tu.Client.HTTPClient())
}

// connectMCP connects an MCP client to the test server through httpClient,
// which carries whatever authentication the test needs.
func connectMCP(t *testing.T, ts *TestServer, httpClient *http.Client) *mcp.ClientSession {
	t.Helper()
	c := mcp.NewClient(&mcp.Implementation{Name: "test-client"}, nil)
	transport := &mcp.StreamableClientTransport{
		Endpoint:             ts.HTTPServer.URL + "/api/v1/mcp",
		HTTPClient:           httpClient,
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
	t.Parallel()
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpuser", "password123", false)
	sess := setupMCPSession(t, ts, tu)

	var notes []client.Note
	callTool(t, sess, "list_notes", map[string]any{}, &notes)
	assert.Empty(t, notes)
}

func TestMCPCreateAndGetNote(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpuser2", "password123", false)
	sess := setupMCPSession(t, ts, tu)

	var created client.Note
	callTool(t, sess, "create_note", map[string]any{
		"content": "Created via MCP",
	}, &created)

	assert.Equal(t, client.NoteTypeText, created.NoteType)
	assert.Equal(t, "Created via MCP", created.Content)
	assert.NotEmpty(t, created.ID)

	var fetched client.Note
	callTool(t, sess, "get_note", map[string]any{"id": created.ID}, &fetched)
	assert.Equal(t, created.ID, fetched.ID)
	assert.Equal(t, "Created via MCP", fetched.Content)
}

func TestMCPUpdateNote(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpuser3", "password123", false)
	sess := setupMCPSession(t, ts, tu)

	var created client.Note
	callTool(t, sess, "create_note", map[string]any{"title": "Before", "note_type": "list"}, &created)

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
	t.Parallel()
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpuser4", "password123", false)
	sess := setupMCPSession(t, ts, tu)

	var created client.Note
	callTool(t, sess, "create_note", map[string]any{"content": "To delete"}, &created)

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
	t.Parallel()
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpuser5", "password123", false)
	sess := setupMCPSession(t, ts, tu)

	// Initially no labels.
	var labels []client.Label
	callTool(t, sess, "list_labels", map[string]any{}, &labels)
	assert.Empty(t, labels)

	// Create a note, then add a label.
	var note client.Note
	callTool(t, sess, "create_note", map[string]any{"content": "Labeled note"}, &note)

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
	callTool(t, sess, "update_label", map[string]any{"id": labelID, "name": "personal"}, &renamed)
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

// TestMCPPermanentDelete verifies that the permanent flag on delete_note
// removes a trashed note from the trash entirely.
func TestMCPPermanentDelete(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpuser6", "password123", false)
	sess := setupMCPSession(t, ts, tu)

	var created client.Note
	callTool(t, sess, "create_note", map[string]any{"content": "permanent delete"}, &created)

	// soft-delete first
	callTool(t, sess, "delete_note", map[string]any{"id": created.ID}, nil)

	// permanently delete
	callTool(t, sess, "delete_note", map[string]any{"id": created.ID, "permanent": true}, nil)

	// should be absent from both active and trashed lists
	var trashed []client.Note
	callTool(t, sess, "list_notes", map[string]any{"trashed": true}, &trashed)
	assert.Empty(t, trashed)
}

// callToolExpectError calls a named MCP tool and asserts it returned a
// tool-level error, returning the error text for further assertions.
func callToolExpectError(t *testing.T, sess *mcp.ClientSession, name string, args any) string {
	t.Helper()
	result, err := sess.CallTool(t.Context(), &mcp.CallToolParams{
		Name:      name,
		Arguments: args,
	})
	require.NoError(t, err)
	require.True(t, result.IsError, "expected tool error from %s", name)
	require.NotEmpty(t, result.Content)
	text, ok := result.Content[0].(*mcp.TextContent)
	require.True(t, ok, "expected TextContent, got %T", result.Content[0])
	return text.Text
}

// TestMCPCreateNoteWithItems verifies that a list note can be created with its
// items in a single call, in the order supplied.
func TestMCPCreateNoteWithItems(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpitems1", "password123", false)
	sess := setupMCPSession(t, ts, tu)

	var created client.Note
	callTool(t, sess, "create_note", map[string]any{
		"title": "Groceries",
		"items": []map[string]any{
			{"text": "Milk"},
			{"text": "Bread", "completed": true},
			{"text": "Eggs"},
		},
	}, &created)

	assert.Equal(t, client.NoteTypeList, created.NoteType)
	require.Len(t, created.Items, 3)
	assert.Equal(t, "Milk", created.Items[0].Text)
	assert.False(t, created.Items[0].Completed)
	assert.Equal(t, "Bread", created.Items[1].Text)
	assert.True(t, created.Items[1].Completed)
	assert.Equal(t, "Eggs", created.Items[2].Text)
	for _, item := range created.Items {
		assert.NotEmpty(t, item.ID, "each item must get a server-generated ID")
	}

	// The items must be readable back through get_note.
	var fetched client.Note
	callTool(t, sess, "get_note", map[string]any{"id": created.ID}, &fetched)
	require.Len(t, fetched.Items, 3)

	t.Run("note_type must agree with items", func(t *testing.T) {
		msg := callToolExpectError(t, sess, "create_note", map[string]any{
			"note_type": "text",
			"items":     []map[string]any{{"text": "nope"}},
		})
		assert.Contains(t, msg, "note_type must be")
	})
}

// TestMCPNoteItemCRUD walks the full item lifecycle over MCP: create, update,
// and delete, against a list note created without items.
func TestMCPNoteItemCRUD(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpitems2", "password123", false)
	sess := setupMCPSession(t, ts, tu)

	var note client.Note
	callTool(t, sess, "create_note", map[string]any{
		"title":     "Packing list",
		"note_type": "list",
	}, &note)
	require.Empty(t, note.Items)

	// Items are appended in call order when position is omitted.
	var first client.NoteItem
	callTool(t, sess, "create_note_item", map[string]any{
		"note_id": note.ID,
		"text":    "Passport",
	}, &first)
	assert.Equal(t, "Passport", first.Text)
	assert.False(t, first.Completed)
	require.NotEmpty(t, first.ID)

	var second client.NoteItem
	callTool(t, sess, "create_note_item", map[string]any{
		"note_id":   note.ID,
		"text":      "Charger",
		"completed": true,
	}, &second)
	assert.True(t, second.Completed)
	assert.Greater(t, second.Position, first.Position, "omitted position must append to the end")
	assert.NotEqual(t, first.ID, second.ID)

	var withItems client.Note
	callTool(t, sess, "get_note", map[string]any{"id": note.ID}, &withItems)
	require.Len(t, withItems.Items, 2)

	// Partial update: only the named field changes.
	var updated client.NoteItem
	callTool(t, sess, "update_note_item", map[string]any{
		"note_id":   note.ID,
		"item_id":   first.ID,
		"completed": true,
	}, &updated)
	assert.True(t, updated.Completed)
	assert.Equal(t, "Passport", updated.Text, "omitted fields must keep their value")

	callTool(t, sess, "update_note_item", map[string]any{
		"note_id": note.ID,
		"item_id": first.ID,
		"text":    "Passport and visa",
	}, &updated)
	assert.Equal(t, "Passport and visa", updated.Text)
	assert.True(t, updated.Completed)

	// Nest the second item under the first.
	callTool(t, sess, "update_note_item", map[string]any{
		"note_id":   note.ID,
		"item_id":   second.ID,
		"parent_id": first.ID,
	}, &updated)
	require.NotNil(t, updated.ParentID)
	assert.Equal(t, first.ID, *updated.ParentID)

	// Delete leaves only the remaining item.
	callTool(t, sess, "delete_note_item", map[string]any{
		"note_id": note.ID,
		"item_id": second.ID,
	}, nil)

	callTool(t, sess, "get_note", map[string]any{"id": note.ID}, &withItems)
	require.Len(t, withItems.Items, 1)
	assert.Equal(t, first.ID, withItems.Items[0].ID)
}

// TestMCPNoteItemErrors covers the guardrails on the item tools.
func TestMCPNoteItemErrors(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpitems3", "password123", false)
	sess := setupMCPSession(t, ts, tu)

	var textNote client.Note
	callTool(t, sess, "create_note", map[string]any{"content": "just text"}, &textNote)

	var listNote client.Note
	callTool(t, sess, "create_note", map[string]any{
		"title":     "List",
		"note_type": "list",
	}, &listNote)

	t.Run("items rejected on a text note", func(t *testing.T) {
		msg := callToolExpectError(t, sess, "create_note_item", map[string]any{
			"note_id": textNote.ID,
			"text":    "nope",
		})
		assert.Contains(t, msg, "list notes")
	})

	t.Run("unknown note", func(t *testing.T) {
		callToolExpectError(t, sess, "create_note_item", map[string]any{
			"note_id": "aaaaaaaaaaaaaaaaaaaaaa",
			"text":    "nope",
		})
	})

	t.Run("unknown item", func(t *testing.T) {
		callToolExpectError(t, sess, "update_note_item", map[string]any{
			"note_id": listNote.ID,
			"item_id": "aaaaaaaaaaaaaaaaaaaaaa",
			"text":    "nope",
		})
	})

	t.Run("item text too long", func(t *testing.T) {
		msg := callToolExpectError(t, sess, "create_note_item", map[string]any{
			"note_id": listNote.ID,
			"text":    strings.Repeat("a", 501),
		})
		assert.Contains(t, msg, "500 characters or fewer")
	})

	t.Run("malformed parent_id", func(t *testing.T) {
		msg := callToolExpectError(t, sess, "create_note_item", map[string]any{
			"note_id":   listNote.ID,
			"text":      "child",
			"parent_id": "not-an-id",
		})
		assert.Equal(t, "create note item: invalid parent_id format", msg, "the same message REST returns")
	})

	t.Run("too many items on create", func(t *testing.T) {
		items := make([]map[string]any, 501)
		for i := range items {
			items[i] = map[string]any{"text": "x"}
		}
		msg := callToolExpectError(t, sess, "create_note", map[string]any{"items": items})
		assert.Contains(t, msg, "more than 500 items")
	})
}

// TestMCPNoteItemCrossUserIsolation verifies that item tools honor note access,
// so one user cannot read or mutate items on another user's note.
func TestMCPNoteItemCrossUserIsolation(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	alice := ts.createTestUser(t, "alice_mcp_items", "password123", false)
	bob := ts.createTestUser(t, "bob_mcp_items", "password123", false)

	aliceSess := setupMCPSession(t, ts, alice)
	bobSess := setupMCPSession(t, ts, bob)

	var aliceNote client.Note
	callTool(t, aliceSess, "create_note", map[string]any{
		"title": "Alice's list",
		"items": []map[string]any{{"text": "secret"}},
	}, &aliceNote)
	require.Len(t, aliceNote.Items, 1)
	aliceItemID := aliceNote.Items[0].ID

	callToolExpectError(t, bobSess, "create_note_item", map[string]any{
		"note_id": aliceNote.ID,
		"text":    "intruder",
	})
	callToolExpectError(t, bobSess, "update_note_item", map[string]any{
		"note_id": aliceNote.ID,
		"item_id": aliceItemID,
		"text":    "tampered",
	})
	callToolExpectError(t, bobSess, "delete_note_item", map[string]any{
		"note_id": aliceNote.ID,
		"item_id": aliceItemID,
	})

	// Alice's item must be untouched.
	var fetched client.Note
	callTool(t, aliceSess, "get_note", map[string]any{"id": aliceNote.ID}, &fetched)
	require.Len(t, fetched.Items, 1)
	assert.Equal(t, "secret", fetched.Items[0].Text)
}

// TestMCPCrossUserIsolation verifies that a user cannot access another user's
// notes via MCP tools.
func TestMCPCrossUserIsolation(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	alice := ts.createTestUser(t, "alice_mcp", "password123", false)
	bob := ts.createTestUser(t, "bob_mcp", "password123", false)

	aliceSess := setupMCPSession(t, ts, alice)
	bobSess := setupMCPSession(t, ts, bob)

	// Alice creates a note.
	var aliceNote client.Note
	callTool(t, aliceSess, "create_note", map[string]any{"content": "Alice's note"}, &aliceNote)

	// Bob tries to get Alice's note — should get a tool error.
	result, err := bobSess.CallTool(t.Context(), &mcp.CallToolParams{
		Name:      "get_note",
		Arguments: map[string]any{"id": aliceNote.ID},
	})
	require.NoError(t, err)
	assert.True(t, result.IsError, "expected tool error when accessing another user's note")
}

func TestMCPUnauthenticated(t *testing.T) {
	t.Parallel()
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

// TestMCPRecordsPATUse verifies that an MCP session authenticated with a
// personal access token, which is how MCP clients are configured, shows up as
// the token's last use.
func TestMCPRecordsPATUse(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpuser", "password123", false)
	pat := createPAT(t, ts, tu, "assistant")

	sess := connectMCP(t, ts, &http.Client{Transport: &headerRoundTripper{
		header: http.Header{"Authorization": {"Bearer " + pat.Token}},
		base:   ts.HTTPServer.Client().Transport,
	}})

	var notes []client.Note
	callTool(t, sess, "list_notes", map[string]any{}, &notes)

	pats := listPATs(t, ts, tu)
	require.Len(t, pats, 1)
	assert.NotNil(t, pats[0].LastUsedAt, "an MCP request authenticated with the token records its use")
}

// TestMCPNoteValidation verifies that the MCP note tools apply the same field
// rules as the REST API, which share them through internal/models.
func TestMCPNoteValidation(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpvalidate", "password123", false)
	sess := setupMCPSession(t, ts, tu)

	var textNote client.Note
	callTool(t, sess, "create_note", map[string]any{"content": "text"}, &textNote)
	var listNote client.Note
	callTool(t, sess, "create_note", map[string]any{"title": "list", "note_type": "list"}, &listNote)

	t.Run("search query over the limit is rejected", func(t *testing.T) {
		msg := callToolExpectError(t, sess, "list_notes", map[string]any{"search": strings.Repeat("a", 501)})
		assert.Equal(t, "list notes: search query must be 500 characters or fewer", msg, "the same message REST returns")

		callTool(t, sess, "list_notes", map[string]any{"search": strings.Repeat("ä", 500)}, nil)
	})

	t.Run("content over the limit is rejected", func(t *testing.T) {
		tooLong := strings.Repeat("a", 10001)
		msg := callToolExpectError(t, sess, "create_note", map[string]any{"content": tooLong})
		assert.Contains(t, msg, "content must be 10000 characters or fewer")

		msg = callToolExpectError(t, sess, "update_note", map[string]any{"id": textNote.ID, "content": tooLong})
		assert.Contains(t, msg, "content must be 10000 characters or fewer")
	})

	t.Run("title over the limit is rejected", func(t *testing.T) {
		tooLong := strings.Repeat("a", 201)
		msg := callToolExpectError(t, sess, "create_note", map[string]any{"title": tooLong, "note_type": "list"})
		assert.Contains(t, msg, "title must be 200 characters or fewer")

		msg = callToolExpectError(t, sess, "update_note", map[string]any{"id": listNote.ID, "title": tooLong})
		assert.Contains(t, msg, "title must be 200 characters or fewer")
	})

	t.Run("a bad color is rejected", func(t *testing.T) {
		msg := callToolExpectError(t, sess, "create_note", map[string]any{"content": "x", "color": "red"})
		assert.Contains(t, msg, "valid CSS hex color")

		msg = callToolExpectError(t, sess, "update_note", map[string]any{"id": textNote.ID, "color": "#12345"})
		assert.Contains(t, msg, "valid CSS hex color")
	})

	t.Run("a color is stored as lowercase six-digit hex", func(t *testing.T) {
		var created client.Note
		callTool(t, sess, "create_note", map[string]any{"content": "x", "color": "#ABC"}, &created)
		assert.Equal(t, "#aabbcc", created.Color)

		var updated client.Note
		callTool(t, sess, "update_note", map[string]any{"id": created.ID, "color": "#F28B82"}, &updated)
		assert.Equal(t, "#f28b82", updated.Color)
	})

	t.Run("an empty color resets to the default", func(t *testing.T) {
		var updated client.Note
		callTool(t, sess, "update_note", map[string]any{"id": textNote.ID, "color": ""}, &updated)
		assert.Equal(t, "#ffffff", updated.Color)
	})

	t.Run("fields foreign to the note type are rejected", func(t *testing.T) {
		msg := callToolExpectError(t, sess, "create_note", map[string]any{"title": "t", "content": "c"})
		assert.Contains(t, msg, "text notes cannot have a title")

		msg = callToolExpectError(t, sess, "update_note", map[string]any{"id": textNote.ID, "title": "t"})
		assert.Contains(t, msg, "text notes cannot have a title")

		msg = callToolExpectError(t, sess, "update_note", map[string]any{"id": listNote.ID, "content": "c"})
		assert.Contains(t, msg, "list notes cannot have content")
	})

	t.Run("a text note's title is stripped from the result", func(t *testing.T) {
		// A text note can still carry a title in the database, e.g. one created
		// over MCP before its writes were validated. Plant one directly.
		ts.exec(t, `UPDATE notes SET title = ? WHERE id = ?`, "legacy title", textNote.ID)

		var fetched client.Note
		callTool(t, sess, "get_note", map[string]any{"id": textNote.ID}, &fetched)
		assert.Empty(t, fetched.Title)
		assert.Equal(t, "text", fetched.Content)

		var updated client.Note
		callTool(t, sess, "update_note", map[string]any{"id": textNote.ID, "pinned": true}, &updated)
		assert.Empty(t, updated.Title)

		var notes []client.Note
		callTool(t, sess, "list_notes", map[string]any{}, &notes)
		for _, n := range notes {
			if n.ID == textNote.ID {
				assert.Empty(t, n.Title)
			}
		}
	})

	t.Run("a label name over the limit is rejected", func(t *testing.T) {
		tooLong := strings.Repeat("ä", 101)
		msg := callToolExpectError(t, sess, "add_label_to_note", map[string]any{"note_id": textNote.ID, "name": tooLong})
		assert.Contains(t, msg, "label name must be 100 characters or fewer")

		var withLabel client.Note
		callTool(t, sess, "add_label_to_note", map[string]any{"note_id": textNote.ID, "name": strings.Repeat("ä", 100)}, &withLabel)
		require.Len(t, withLabel.Labels, 1)

		msg = callToolExpectError(t, sess, "update_label", map[string]any{"id": withLabel.Labels[0].ID, "name": tooLong})
		assert.Contains(t, msg, "label name must be 100 characters or fewer")
	})
}

// TestMCPPublishesSSE verifies that MCP writes reach open clients through the
// same SSE events the REST API publishes.
func TestMCPPublishesSSE(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "mcpsseowner", "password123", false)
	collaborator := ts.createTestUser(t, "mcpssecollab", "password123", false)
	sess := setupMCPSession(t, ts, owner)

	sseCtx, sseCancel := context.WithCancel(t.Context())
	t.Cleanup(sseCancel)
	ownerEvents, err := owner.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)
	collabEvents, err := collaborator.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)

	fromOwner := func(eventType sse.EventType, noteID string) func(client.SSEEvent) bool {
		return func(e client.SSEEvent) bool {
			return e.Type == string(eventType) && e.SourceUserID == owner.User.ID &&
				e.NoteData != nil && e.NoteData.NoteID == noteID
		}
	}

	var note client.Note
	callTool(t, sess, "create_note", map[string]any{"title": "Shared list", "note_type": "list"}, &note)
	_, found := waitForSSEEvent(ownerEvents, fromOwner(sse.EventNoteCreated, note.ID), 3*time.Second)
	require.True(t, found, "create_note should publish note_created")

	require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collaborator.User.ID))

	t.Run("update_note reaches every collaborator", func(t *testing.T) {
		callTool(t, sess, "update_note", map[string]any{"id": note.ID, "title": "Renamed via MCP"}, nil)
		event, found := waitForSSEEvent(collabEvents, fromOwner(sse.EventNoteUpdated, note.ID), 3*time.Second)
		require.True(t, found, "update_note should publish note_updated to the collaborator")
		require.NotNil(t, event.NoteData.Note)
		assert.Equal(t, "Renamed via MCP", event.NoteData.Note.Title)
	})

	t.Run("item changes reach every collaborator", func(t *testing.T) {
		callTool(t, sess, "create_note_item", map[string]any{"note_id": note.ID, "text": "Milk"}, nil)
		event, found := waitForSSEEvent(collabEvents, fromOwner(sse.EventNoteUpdated, note.ID), 3*time.Second)
		require.True(t, found, "create_note_item should publish note_updated to the collaborator")
		require.NotNil(t, event.NoteData.Note)
		require.Len(t, event.NoteData.Note.Items, 1)
	})

	t.Run("label changes reach the acting user", func(t *testing.T) {
		callTool(t, sess, "add_label_to_note", map[string]any{"note_id": note.ID, "name": "groceries"}, nil)
		// The owner's stream also holds the earlier updates, so match on the label.
		isUpdate := fromOwner(sse.EventNoteUpdated, note.ID)
		_, found := waitForSSEEvent(ownerEvents, func(e client.SSEEvent) bool {
			return isUpdate(e) && e.NoteData.Note != nil && len(e.NoteData.Note.Labels) == 1 &&
				e.NoteData.Note.Labels[0].Name == "groceries"
		}, 3*time.Second)
		require.True(t, found, "add_label_to_note should publish note_updated carrying the label")
	})

	t.Run("delete_note reaches every collaborator", func(t *testing.T) {
		callTool(t, sess, "delete_note", map[string]any{"id": note.ID}, nil)
		_, found := waitForSSEEvent(collabEvents, fromOwner(sse.EventNoteDeleted, note.ID), 3*time.Second)
		require.True(t, found, "delete_note should publish note_deleted to the collaborator")
	})
}

// TestMCPCreateNoteLabelsAndPinned verifies that create_note attaches labels
// and pins the note in the same call.
func TestMCPCreateNoteLabelsAndPinned(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpcreatelabels", "password123", false)
	sess := setupMCPSession(t, ts, tu)

	var seed client.Note
	callTool(t, sess, "create_note", map[string]any{"content": "seed", "labels": []string{"Work"}}, &seed)
	require.Len(t, seed.Labels, 1)
	workID := seed.Labels[0].ID

	t.Run("labels and pinned are applied", func(t *testing.T) {
		var created client.Note
		callTool(t, sess, "create_note", map[string]any{
			"content": "Quarterly report",
			"pinned":  true,
			// " work " and "WORK" resolve to the existing label; "" is skipped.
			"labels": []string{" work ", "WORK", "", "reports"},
		}, &created)
		assert.True(t, created.Pinned)
		require.Len(t, created.Labels, 2)
		assert.ElementsMatch(t, []string{"Work", "reports"}, []string{created.Labels[0].Name, created.Labels[1].Name})
		assert.Contains(t, []string{created.Labels[0].ID, created.Labels[1].ID}, workID)

		var fetched client.Note
		callTool(t, sess, "get_note", map[string]any{"id": created.ID}, &fetched)
		assert.True(t, fetched.Pinned)
		assert.Len(t, fetched.Labels, 2)
	})

	t.Run("a new label name over the limit creates nothing", func(t *testing.T) {
		var before []client.Note
		callTool(t, sess, "list_notes", map[string]any{}, &before)
		var labelsBefore []client.Label
		callTool(t, sess, "list_labels", map[string]any{}, &labelsBefore)

		msg := callToolExpectError(t, sess, "create_note", map[string]any{
			"content": "never created",
			// The valid name ahead of the bad one must not be created either.
			"labels": []string{"fresh", strings.Repeat("a", 101)},
		})
		assert.Contains(t, msg, "label name must be 100 characters or fewer")

		var after []client.Note
		callTool(t, sess, "list_notes", map[string]any{}, &after)
		assert.Len(t, after, len(before))
		var labelsAfter []client.Label
		callTool(t, sess, "list_labels", map[string]any{}, &labelsAfter)
		assert.Len(t, labelsAfter, len(labelsBefore))
	})
}

// TestMCPUpdateNoteBaseVersion verifies the optimistic-concurrency guard on
// update_note: a current base_version applies, a stale one changes nothing.
func TestMCPUpdateNoteBaseVersion(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	tu := ts.createTestUser(t, "mcpbaseversion", "password123", false)
	sess := setupMCPSession(t, ts, tu)

	var note client.Note
	callTool(t, sess, "create_note", map[string]any{"content": "v1"}, &note)
	staleVersion := note.Version

	var updated client.Note
	callTool(t, sess, "update_note", map[string]any{
		"id":           note.ID,
		"content":      "v2",
		"base_version": note.Version,
	}, &updated)
	assert.Equal(t, "v2", updated.Content)
	assert.Greater(t, updated.Version, staleVersion)

	msg := callToolExpectError(t, sess, "update_note", map[string]any{
		"id":           note.ID,
		"content":      "stale edit",
		"pinned":       true,
		"base_version": staleVersion,
	})
	assert.Contains(t, msg, "get_note")

	var fetched client.Note
	callTool(t, sess, "get_note", map[string]any{"id": note.ID}, &fetched)
	assert.Equal(t, "v2", fetched.Content)
	assert.Equal(t, updated.Version, fetched.Version)
	assert.False(t, fetched.Pinned, "a rejected update must not apply its per-user fields either")
}

// TestMCPItemAssignment verifies assigned_to on the item tools and the
// my_tasks filter on list_notes.
func TestMCPItemAssignment(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "mcpassignowner", "password123", false)
	collaborator := ts.createTestUser(t, "mcpassigncollab", "password123", false)
	outsider := ts.createTestUser(t, "mcpassignoutsider", "password123", false)
	ownerSess := setupMCPSession(t, ts, owner)
	collabSess := setupMCPSession(t, ts, collaborator)

	var note client.Note
	callTool(t, ownerSess, "create_note", map[string]any{
		"title": "Chores",
		"items": []map[string]any{{"text": "Dishes"}},
	}, &note)
	require.Len(t, note.Items, 1)
	dishesID := note.Items[0].ID

	t.Run("an unshared note rejects assignment", func(t *testing.T) {
		msg := callToolExpectError(t, ownerSess, "update_note_item", map[string]any{
			"note_id":     note.ID,
			"item_id":     dishesID,
			"assigned_to": owner.User.ID,
		})
		assert.Contains(t, msg, "unshared note")
	})

	require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collaborator.User.ID))

	t.Run("create_note_item assigns", func(t *testing.T) {
		var item client.NoteItem
		callTool(t, ownerSess, "create_note_item", map[string]any{
			"note_id":     note.ID,
			"text":        "Laundry",
			"assigned_to": collaborator.User.ID,
		}, &item)
		assert.Equal(t, collaborator.User.ID, item.AssignedTo)

		var tasks []client.Note
		callTool(t, collabSess, "list_notes", map[string]any{"my_tasks": true}, &tasks)
		require.Len(t, tasks, 1)
		assert.Equal(t, note.ID, tasks[0].ID)

		callTool(t, ownerSess, "list_notes", map[string]any{"my_tasks": true}, &tasks)
		assert.Empty(t, tasks)
	})

	t.Run("update_note_item assigns and unassigns", func(t *testing.T) {
		var item client.NoteItem
		callTool(t, ownerSess, "update_note_item", map[string]any{
			"note_id":     note.ID,
			"item_id":     dishesID,
			"assigned_to": owner.User.ID,
		}, &item)
		assert.Equal(t, owner.User.ID, item.AssignedTo)
		assert.Equal(t, "Dishes", item.Text, "omitted fields must keep their value")

		var tasks []client.Note
		callTool(t, ownerSess, "list_notes", map[string]any{"my_tasks": true}, &tasks)
		require.Len(t, tasks, 1)

		callTool(t, ownerSess, "update_note_item", map[string]any{
			"note_id":     note.ID,
			"item_id":     dishesID,
			"assigned_to": "",
		}, &item)
		assert.Empty(t, item.AssignedTo)

		callTool(t, ownerSess, "list_notes", map[string]any{"my_tasks": true}, &tasks)
		assert.Empty(t, tasks)
	})

	t.Run("invalid assignees are rejected", func(t *testing.T) {
		msg := callToolExpectError(t, ownerSess, "create_note_item", map[string]any{
			"note_id":     note.ID,
			"text":        "Groceries",
			"assigned_to": outsider.User.ID,
		})
		assert.Contains(t, msg, "does not have access")

		msg = callToolExpectError(t, ownerSess, "update_note_item", map[string]any{
			"note_id":     note.ID,
			"item_id":     dishesID,
			"assigned_to": "not-an-id",
		})
		assert.Contains(t, msg, "invalid assigned_to format")
	})
}

// TestMCPRestoreNote verifies that restore_note undoes delete_note and tells
// every collaborator the note is back.
func TestMCPRestoreNote(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "mcprestoreowner", "password123", false)
	collaborator := ts.createTestUser(t, "mcprestorecollab", "password123", false)
	sess := setupMCPSession(t, ts, owner)

	var note client.Note
	callTool(t, sess, "create_note", map[string]any{"content": "Restore me"}, &note)
	require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collaborator.User.ID))

	t.Run("a note not in the trash is rejected", func(t *testing.T) {
		msg := callToolExpectError(t, sess, "restore_note", map[string]any{"id": note.ID})
		assert.Contains(t, msg, "not found in trash")
	})

	callTool(t, sess, "delete_note", map[string]any{"id": note.ID}, nil)

	t.Run("a collaborator cannot restore", func(t *testing.T) {
		collabSess := setupMCPSession(t, ts, collaborator)
		callToolExpectError(t, collabSess, "restore_note", map[string]any{"id": note.ID})
	})

	sseCtx, sseCancel := context.WithCancel(t.Context())
	t.Cleanup(sseCancel)
	collabEvents, err := collaborator.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)

	var restored client.Note
	callTool(t, sess, "restore_note", map[string]any{"id": note.ID}, &restored)
	assert.Equal(t, note.ID, restored.ID)
	assert.Equal(t, "Restore me", restored.Content)

	var active []client.Note
	callTool(t, sess, "list_notes", map[string]any{}, &active)
	require.Len(t, active, 1)
	assert.Equal(t, note.ID, active[0].ID)

	event, found := waitForSSEEvent(collabEvents, func(e client.SSEEvent) bool {
		return e.Type == string(sse.EventNoteUpdated) && e.SourceUserID == owner.User.ID &&
			e.NoteData != nil && e.NoteData.NoteID == note.ID
	}, 3*time.Second)
	require.True(t, found, "restore_note should publish note_updated to the collaborator")
	require.NotNil(t, event.NoteData.Note)
	assert.Equal(t, "Restore me", event.NoteData.Note.Content)
}

// TestMCPListUsers verifies that list_users matches GET /users: everyone but
// the caller, filtered by search, with the search length validated.
func TestMCPListUsers(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	caller := ts.createTestUser(t, "mcplistcaller", "password123", false)
	ana := ts.createTestUser(t, "mcplistana", "password123", false)
	bob := ts.createTestUser(t, "mcplistbob", "password123", false)
	sess := setupMCPSession(t, ts, caller)

	type listUsersResult struct {
		Users []struct {
			ID       string `json:"id"`
			Username string `json:"username"`
		} `json:"users"`
		Truncated bool `json:"truncated"`
	}

	t.Run("without search lists everyone but the caller", func(t *testing.T) {
		var result listUsersResult
		callTool(t, sess, "list_users", map[string]any{}, &result)
		got := make([]string, 0, len(result.Users))
		for _, u := range result.Users {
			got = append(got, u.ID)
		}
		assert.Contains(t, got, ana.User.ID)
		assert.Contains(t, got, bob.User.ID)
		assert.NotContains(t, got, caller.User.ID)
		assert.False(t, result.Truncated)
	})

	t.Run("search filters", func(t *testing.T) {
		var result listUsersResult
		callTool(t, sess, "list_users", map[string]any{"search": "ana"}, &result)
		require.Len(t, result.Users, 1)
		assert.Equal(t, ana.User.ID, result.Users[0].ID)
		assert.Equal(t, "mcplistana", result.Users[0].Username)
	})

	t.Run("an overlong search is rejected", func(t *testing.T) {
		msg := callToolExpectError(t, sess, "list_users", map[string]any{"search": strings.Repeat("a", 1000)})
		assert.Contains(t, msg, "characters or fewer")
	})
}

// TestMCPShareNote verifies share_note and unshare_note: the REST API's rules
// and the same note_shared and note_unshared events.
func TestMCPShareNote(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "mcpshareowner", "password123", false)
	collaborator := ts.createTestUser(t, "mcpsharecollab", "password123", false)
	other := ts.createTestUser(t, "mcpshareother", "password123", false)
	ownerSess := setupMCPSession(t, ts, owner)
	collabSess := setupMCPSession(t, ts, collaborator)

	sseCtx, sseCancel := context.WithCancel(t.Context())
	t.Cleanup(sseCancel)
	collabEvents, err := collaborator.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)
	otherEvents, err := other.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)

	var note client.Note
	callTool(t, ownerSess, "create_note", map[string]any{"content": "Plans"}, &note)

	isEvent := func(eventType sse.EventType, source, target string) func(client.SSEEvent) bool {
		return func(e client.SSEEvent) bool {
			return e.Type == string(eventType) && e.SourceUserID == source && e.TargetUserID == target &&
				e.NoteData != nil && e.NoteData.NoteID == note.ID
		}
	}

	t.Run("share_note shares and notifies the new collaborator", func(t *testing.T) {
		var result map[string]any
		callTool(t, ownerSess, "share_note", map[string]any{"note_id": note.ID, "user_id": collaborator.User.ID}, &result)
		assert.Equal(t, true, result["shared"])

		_, found := waitForSSEEvent(collabEvents, isEvent(sse.EventNoteShared, owner.User.ID, collaborator.User.ID), 3*time.Second)
		require.True(t, found, "share_note should publish note_shared to the new collaborator")

		var fetched client.Note
		callTool(t, collabSess, "get_note", map[string]any{"id": note.ID}, &fetched)
		assert.Equal(t, "Plans", fetched.Content)
	})

	t.Run("share_note errors", func(t *testing.T) {
		tests := []struct {
			name string
			sess *mcp.ClientSession
			user string
			want string
		}{
			{"already shared", ownerSess, collaborator.User.ID, "already shared"},
			{"with self", ownerSess, owner.User.ID, "cannot share with self"},
			{"invalid user ID", ownerSess, "not-an-id", "invalid user_id"},
			{"unknown user", ownerSess, "AAAAAAAAAAAAAAAAAAAAAA", "user not found"},
			{"not the owner", collabSess, other.User.ID, "not owner"},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				msg := callToolExpectError(t, tt.sess, "share_note", map[string]any{"note_id": note.ID, "user_id": tt.user})
				assert.Contains(t, msg, tt.want)
			})
		}
	})

	t.Run("only the owner can remove someone else", func(t *testing.T) {
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, other.User.ID))
		msg := callToolExpectError(t, collabSess, "unshare_note", map[string]any{"note_id": note.ID, "user_id": other.User.ID})
		assert.Contains(t, msg, "not owner")
	})

	t.Run("the owner removes a collaborator", func(t *testing.T) {
		var result map[string]any
		callTool(t, ownerSess, "unshare_note", map[string]any{"note_id": note.ID, "user_id": other.User.ID}, &result)
		assert.Equal(t, false, result["shared"])

		_, found := waitForSSEEvent(otherEvents, isEvent(sse.EventNoteUnshared, owner.User.ID, other.User.ID), 3*time.Second)
		require.True(t, found, "unshare_note should publish note_unshared to the removed user")
	})

	t.Run("a collaborator leaves by omitting user_id", func(t *testing.T) {
		var result map[string]any
		callTool(t, collabSess, "unshare_note", map[string]any{"note_id": note.ID}, &result)
		assert.Equal(t, collaborator.User.ID, result["user_id"])

		_, found := waitForSSEEvent(collabEvents, isEvent(sse.EventNoteUnshared, collaborator.User.ID, collaborator.User.ID), 3*time.Second)
		require.True(t, found, "leaving should publish note_unshared")

		callToolExpectError(t, collabSess, "get_note", map[string]any{"id": note.ID})
	})
}
