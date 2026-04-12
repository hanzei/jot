package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNoteValidation(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "validationuser", "password123", false)

	// postNote sends a raw JSON body to POST /api/v1/notes for testing server-side validation
	// of requests that cannot be expressed with the typed client methods.
	postNote := func(t *testing.T, body map[string]any) int {
		t.Helper()
		data, err := json.Marshal(body)
		require.NoError(t, err)
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
			ts.HTTPServer.URL+"/api/v1/notes", bytes.NewReader(data))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		resp, err := user.Client.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		return resp.StatusCode
	}

	// patchNote sends a raw JSON body to PATCH /api/v1/notes/{id} for testing server-side validation.
	patchNote := func(t *testing.T, noteID string, body map[string]any) int {
		t.Helper()
		data, err := json.Marshal(body)
		require.NoError(t, err)
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPatch,
			ts.HTTPServer.URL+"/api/v1/notes/"+noteID, bytes.NewReader(data))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		resp, err := user.Client.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		return resp.StatusCode
	}

	// Title is a field on list notes. These tests use list notes to validate title length.
	t.Run("title max length on create", func(t *testing.T) {
		t.Run("exceeding max returns 400", func(t *testing.T) {
			_, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
				Title: strings.Repeat("a", 201),
			})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})

		t.Run("at max length succeeds", func(t *testing.T) {
			note, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
				Title: strings.Repeat("a", 200),
			})
			require.NoError(t, err)
			assert.Len(t, []rune(note.Title), 200)
		})

		t.Run("multi-byte characters counted as characters not bytes", func(t *testing.T) {
			// "é" is 2 bytes in UTF-8 but 1 character; 200 of them must be accepted.
			title200 := strings.Repeat("é", 200)
			note, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
				Title: title200,
			})
			require.NoError(t, err)
			assert.Equal(t, title200, note.Title)

			// 201 multi-byte characters must be rejected.
			_, err = user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
				Title: strings.Repeat("é", 201),
			})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})
	})

	t.Run("content max length on create", func(t *testing.T) {
		t.Run("exceeding max returns 400", func(t *testing.T) {
			_, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
				Content: strings.Repeat("a", 10001),
			})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})

		t.Run("at max length succeeds", func(t *testing.T) {
			note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
				Content: strings.Repeat("a", 10000),
			})
			require.NoError(t, err)
			assert.Len(t, []rune(note.Content), 10000)
		})
	})

	// Use a list note for title update validation (title is a list-note field).
	// Use a separate text note for content update validation.
	t.Run("title max length on update", func(t *testing.T) {
		listNote, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
			Title: "original",
		})
		require.NoError(t, err)

		t.Run("title exceeding max returns 400", func(t *testing.T) {
			longTitle := strings.Repeat("a", 201)
			_, err := user.Client.UpdateListNote(t.Context(), listNote.ID, &client.UpdateListNoteRequest{Title: &longTitle})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})
	})

	t.Run("content max length on update", func(t *testing.T) {
		textNote, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "original"})
		require.NoError(t, err)

		t.Run("content exceeding max returns 400", func(t *testing.T) {
			longContent := strings.Repeat("a", 10001)
			_, err := user.Client.UpdateTextNote(t.Context(), textNote.ID, &client.UpdateTextNoteRequest{Content: &longContent})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})
	})

	t.Run("item text max length", func(t *testing.T) {
		t.Run("exceeding max on create returns 400", func(t *testing.T) {
			_, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
				Items: []client.CreateNoteItem{
					{Text: strings.Repeat("a", 501), Position: 0},
				},
			})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})

		t.Run("at max length on create succeeds", func(t *testing.T) {
			note, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
				Items: []client.CreateNoteItem{
					{Text: strings.Repeat("a", 500), Position: 0},
				},
			})
			require.NoError(t, err)
			require.Len(t, note.Items, 1)
			assert.Len(t, []rune(note.Items[0].Text), 500)
		})

		t.Run("exceeding max on update returns 400", func(t *testing.T) {
			note, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
				Items: []client.CreateNoteItem{{Text: "original", Position: 0}},
			})
			require.NoError(t, err)

			updateItems := []client.UpdateNoteItem{
				{Text: strings.Repeat("a", 501), Position: 0},
			}
			_, err = user.Client.UpdateListNote(t.Context(), note.ID, &client.UpdateListNoteRequest{
				Items: &updateItems,
			})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})
	})

	t.Run("color validation", func(t *testing.T) {
		t.Run("invalid color on create returns 400", func(t *testing.T) {
			for _, color := range []string{"red", "#gggggg", "#12345", "ffffff", "#1234567"} {
				_, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
					Content: "test",
					Color:   color,
				})
				assert.Equal(t, http.StatusBadRequest, client.StatusCode(err), "expected 400 for color %q", color)
			}
		})

		t.Run("valid 3-digit hex on create succeeds", func(t *testing.T) {
			note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
				Content: "test",
				Color:   "#fff",
			})
			require.NoError(t, err)
			assert.Equal(t, "#fff", note.Color)
		})

		t.Run("valid 6-digit hex on create succeeds", func(t *testing.T) {
			note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
				Content: "test",
				Color:   "#1a2b3c",
			})
			require.NoError(t, err)
			assert.Equal(t, "#1a2b3c", note.Color)
		})

		t.Run("empty color on create uses default", func(t *testing.T) {
			note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
				Content: "test",
				Color:   "",
			})
			require.NoError(t, err)
			assert.Equal(t, "#ffffff", note.Color)
		})

		t.Run("invalid color on update returns 400", func(t *testing.T) {
			note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "test"})
			require.NoError(t, err)

			for _, color := range []string{"red", "#gggggg", "#12345", "ffffff", "#1234567"} {
				c := color
				_, err := user.Client.UpdateTextNote(t.Context(), note.ID, &client.UpdateTextNoteRequest{Color: &c})
				assert.Equal(t, http.StatusBadRequest, client.StatusCode(err), "expected 400 for color %q", color)
			}
		})

		t.Run("valid 3-digit hex on update succeeds", func(t *testing.T) {
			note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "test"})
			require.NoError(t, err)

			color := "#abc"
			updated, err := user.Client.UpdateTextNote(t.Context(), note.ID, &client.UpdateTextNoteRequest{Color: &color})
			require.NoError(t, err)
			assert.Equal(t, "#abc", updated.Color)
		})

		t.Run("valid 6-digit hex on update succeeds", func(t *testing.T) {
			note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "test"})
			require.NoError(t, err)

			color := "#FFFFFF"
			updated, err := user.Client.UpdateTextNote(t.Context(), note.ID, &client.UpdateTextNoteRequest{Color: &color})
			require.NoError(t, err)
			assert.Equal(t, "#FFFFFF", updated.Color)
		})

		t.Run("empty string color on update uses default", func(t *testing.T) {
			note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "test", Color: "#abc"})
			require.NoError(t, err)

			empty := ""
			updated, err := user.Client.UpdateTextNote(t.Context(), note.ID, &client.UpdateTextNoteRequest{Color: &empty})
			require.NoError(t, err)
			assert.Equal(t, "#ffffff", updated.Color)
		})
	})

	t.Run("item count max", func(t *testing.T) {
		t.Run("exceeding max on create returns 400", func(t *testing.T) {
			items := make([]client.CreateNoteItem, 501)
			for i := range items {
				items[i] = client.CreateNoteItem{Text: "item", Position: i}
			}
			_, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{Items: items})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})

		t.Run("exceeding max on update returns 400", func(t *testing.T) {
			note, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
				Items: []client.CreateNoteItem{{Text: "original", Position: 0}},
			})
			require.NoError(t, err)

			items := make([]client.UpdateNoteItem, 501)
			for i := range items {
				items[i] = client.UpdateNoteItem{Text: "item", Position: i}
			}
			_, err = user.Client.UpdateListNote(t.Context(), note.ID, &client.UpdateListNoteRequest{Items: &items})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})
	})

	t.Run("type-field mismatch on create", func(t *testing.T) {
		t.Run("text note with title returns 400", func(t *testing.T) {
			// Send a raw request to test server-side rejection of title on a text note.
			assert.Equal(t, http.StatusBadRequest, postNote(t, map[string]any{
				"note_type": "text",
				"title":     "should not be allowed",
				"content":   "some content",
			}))
		})

		t.Run("list note with content returns 400", func(t *testing.T) {
			// Send a raw request to test server-side rejection of content on a list note.
			assert.Equal(t, http.StatusBadRequest, postNote(t, map[string]any{
				"note_type": "list",
				"content":   "should not be allowed",
				"title":     "some title",
			}))
		})
	})

	t.Run("type-field mismatch on update", func(t *testing.T) {
		t.Run("text note with title returns 400", func(t *testing.T) {
			textNote, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "original"})
			require.NoError(t, err)

			// Send a raw request to test server-side rejection of title on a text note.
			assert.Equal(t, http.StatusBadRequest, patchNote(t, textNote.ID, map[string]any{
				"title": "should not be allowed",
			}))
		})

		t.Run("list note with content returns 400", func(t *testing.T) {
			listNote, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
				Title: "original",
			})
			require.NoError(t, err)

			// Send a raw request to test server-side rejection of content on a list note.
			assert.Equal(t, http.StatusBadRequest, patchNote(t, listNote.ID, map[string]any{
				"content": "should not be allowed",
			}))
		})

		t.Run("update text note with items returns 400", func(t *testing.T) {
			textNote, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "original"})
			require.NoError(t, err)

			// Send a raw request to test server-side rejection of items on a text note.
			assert.Equal(t, http.StatusBadRequest, patchNote(t, textNote.ID, map[string]any{
				"items": []map[string]any{{"text": "item", "position": 0}},
			}))
		})

		t.Run("update text note with checked_items_collapsed returns 400", func(t *testing.T) {
			textNote, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "original"})
			require.NoError(t, err)

			// Send a raw request to test server-side rejection of checked_items_collapsed on a text note.
			assert.Equal(t, http.StatusBadRequest, patchNote(t, textNote.ID, map[string]any{
				"checked_items_collapsed": true,
			}))
		})
	})

	t.Run("update with explicit empty items clears list items", func(t *testing.T) {
		note, err := user.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
			Items: []client.CreateNoteItem{
				{Text: "only item", Position: 0},
			},
		})
		require.NoError(t, err)
		require.Len(t, note.Items, 1)

		emptyItems := []client.UpdateNoteItem{}
		updated, err := user.Client.UpdateListNote(t.Context(), note.ID, &client.UpdateListNoteRequest{
			Items: &emptyItems,
		})
		require.NoError(t, err)
		assert.Empty(t, updated.Items)

		reloaded, err := user.Client.GetNote(t.Context(), note.ID)
		require.NoError(t, err)
		assert.Empty(t, reloaded.Items)
	})
}
