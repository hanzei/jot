package main

import (
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

	t.Run("title max length on create", func(t *testing.T) {
		t.Run("exceeding max returns 400", func(t *testing.T) {
			_, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
				Title: strings.Repeat("a", 201),
			})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})

		t.Run("at max length succeeds", func(t *testing.T) {
			note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
				Title: strings.Repeat("a", 200),
			})
			require.NoError(t, err)
			assert.Len(t, []rune(note.Title), 200)
		})

		t.Run("multi-byte characters counted as characters not bytes", func(t *testing.T) {
			// "é" is 2 bytes in UTF-8 but 1 character; 200 of them must be accepted.
			title200 := strings.Repeat("é", 200)
			note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
				Title: title200,
			})
			require.NoError(t, err)
			assert.Equal(t, title200, note.Title)

			// 201 multi-byte characters must be rejected.
			_, err = user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
				Title: strings.Repeat("é", 201),
			})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})
	})

	t.Run("content max length on create", func(t *testing.T) {
		t.Run("exceeding max returns 400", func(t *testing.T) {
			_, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
				Content: strings.Repeat("a", 10001),
			})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})

		t.Run("at max length succeeds", func(t *testing.T) {
			note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
				Content: strings.Repeat("a", 10000),
			})
			require.NoError(t, err)
			assert.Len(t, []rune(note.Content), 10000)
		})
	})

	t.Run("title and content max length on update", func(t *testing.T) {
		note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{Title: "original"})
		require.NoError(t, err)

		t.Run("title exceeding max returns 400", func(t *testing.T) {
			longTitle := strings.Repeat("a", 201)
			_, err := user.Client.UpdateNote(t.Context(), note.ID, &client.UpdateNoteRequest{Title: &longTitle})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})

		t.Run("content exceeding max returns 400", func(t *testing.T) {
			longContent := strings.Repeat("a", 10001)
			_, err := user.Client.UpdateNote(t.Context(), note.ID, &client.UpdateNoteRequest{Content: &longContent})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})
	})

	t.Run("item text max length", func(t *testing.T) {
		t.Run("exceeding max on create returns 400", func(t *testing.T) {
			_, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
				Items: []client.CreateNoteItem{
					{Text: strings.Repeat("a", 501), Position: 0},
				},
			})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})

		t.Run("at max length on create succeeds", func(t *testing.T) {
			note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
				Items: []client.CreateNoteItem{
					{Text: strings.Repeat("a", 500), Position: 0},
				},
			})
			require.NoError(t, err)
			require.Len(t, note.Items, 1)
			assert.Len(t, []rune(note.Items[0].Text), 500)
		})

		t.Run("exceeding max on update returns 400", func(t *testing.T) {
			note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
				Items: []client.CreateNoteItem{{Text: "original", Position: 0}},
			})
			require.NoError(t, err)

			_, err = user.Client.UpdateNote(t.Context(), note.ID, &client.UpdateNoteRequest{
				Items: []client.UpdateNoteItem{
					{Text: strings.Repeat("a", 501), Position: 0},
				},
			})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})
	})

	t.Run("item count max", func(t *testing.T) {
		t.Run("exceeding max on create returns 400", func(t *testing.T) {
			items := make([]client.CreateNoteItem, 501)
			for i := range items {
				items[i] = client.CreateNoteItem{Text: "item", Position: i}
			}
			_, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{Items: items})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})

		t.Run("exceeding max on update returns 400", func(t *testing.T) {
			note, err := user.Client.CreateNote(t.Context(), &client.CreateNoteRequest{
				Items: []client.CreateNoteItem{{Text: "original", Position: 0}},
			})
			require.NoError(t, err)

			items := make([]client.UpdateNoteItem, 501)
			for i := range items {
				items[i] = client.UpdateNoteItem{Text: "item", Position: i}
			}
			_, err = user.Client.UpdateNote(t.Context(), note.ID, &client.UpdateNoteRequest{Items: items})
			assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		})
	})
}
