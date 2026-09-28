package main

import (
	"context"
	"encoding/json"
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
		_, err := ts.Server.GetDB().ExecContext(t.Context(), `UPDATE notes SET title = ? WHERE id = ?`, "legacy title", textNote.ID)
		require.NoError(t, err)

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
