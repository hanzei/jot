package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/sse"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// publicGet fetches path (relative to /api/v1/public/notes/) without a session
// and returns the status, headers and body.
func (ts *TestServer) publicGet(t *testing.T, path string) (int, http.Header, []byte) {
	t.Helper()
	return rawRequest(t, ts.httpClient, http.MethodGet, ts.HTTPServer.URL+"/api/v1/public/notes/"+path, nil, nil)
}

// publicNoteStatus is the status of the anonymous GET of token's note.
func (ts *TestServer) publicNoteStatus(t *testing.T, token string) int {
	t.Helper()
	status, _, _ := ts.publicGet(t, token)
	return status
}

// requirePublicNotFound asserts the anonymous GET of path is the one 404
// every dead public link answers with, headers included, and returns its body.
func (ts *TestServer) requirePublicNotFound(t *testing.T, path string) []byte {
	t.Helper()
	status, header, body := ts.publicGet(t, path)
	msg := requireEnvelope(t, http.StatusNotFound, "not_found", status, header, body)
	assert.Equal(t, models.ErrPublicLinkNotFound.Error(), msg)
	assert.Equal(t, "noindex", header.Get("X-Robots-Tag"))
	assert.Equal(t, "no-referrer", header.Get("Referrer-Policy"))
	return body
}

func TestPublicLinkLifecycle(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "plowner", "password123", false)
	anon := ts.newClient()

	note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "# Recipe\n\nflour"})
	require.NoError(t, err)
	before, err := owner.Client.GetNote(t.Context(), note.ID)
	require.NoError(t, err)
	assert.Nil(t, before.PublicLink, "a note starts without a public link")

	// Create, then view without login.
	link, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
	require.NoError(t, err)
	assert.Len(t, link.Token, 43)
	assert.True(t, models.IsValidPublicLinkToken(link.Token))
	require.NotNil(t, link.CreatedBy)
	assert.Equal(t, owner.User.ID, *link.CreatedBy)
	assert.Nil(t, link.ExpiresAt)

	pub, err := anon.GetPublicNote(t.Context(), link.Token)
	require.NoError(t, err)
	require.NotNil(t, pub.Content)
	assert.Equal(t, "# Recipe\n\nflour", *pub.Content)

	after, err := owner.Client.GetNote(t.Context(), note.ID)
	require.NoError(t, err)
	require.NotNil(t, after.PublicLink)
	assert.Equal(t, link.Token, after.PublicLink.Token)
	assert.Equal(t, before.Version, after.Version, "a public link change does not bump the note's version")
	assert.Equal(t, before.UpdatedAt, after.UpdatedAt, "a public link change does not touch updated_at")

	notes, err := owner.Client.ListNotes(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, notes, 1)
	require.NotNil(t, notes[0].PublicLink, "list responses carry public_link too")
	assert.Equal(t, link.Token, notes[0].PublicLink.Token)

	// Change the expiry: the same URL keeps working.
	expires := time.Now().Add(7 * 24 * time.Hour).UTC().Truncate(time.Second)
	changed, err := owner.Client.SetPublicLink(t.Context(), note.ID, &expires)
	require.NoError(t, err)
	assert.Equal(t, link.Token, changed.Token)
	assert.Equal(t, link.CreatedAt, changed.CreatedAt)
	require.NotNil(t, changed.ExpiresAt)
	assert.True(t, expires.Equal(*changed.ExpiresAt), "want %v, got %v", expires, *changed.ExpiresAt)
	assert.Equal(t, http.StatusOK, ts.publicNoteStatus(t, link.Token))

	// Back to no expiry.
	unexpiring, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
	require.NoError(t, err)
	assert.Equal(t, link.Token, unexpiring.Token)
	assert.Nil(t, unexpiring.ExpiresAt)

	// Revoke: 404.
	require.NoError(t, owner.Client.DeletePublicLink(t.Context(), note.ID))
	ts.requirePublicNotFound(t, link.Token)
	revoked, err := owner.Client.GetNote(t.Context(), note.ID)
	require.NoError(t, err)
	assert.Nil(t, revoked.PublicLink)

	// Revoking again is not an error.
	require.NoError(t, owner.Client.DeletePublicLink(t.Context(), note.ID))

	// Create again: a new URL works, the old one still 404s.
	second, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
	require.NoError(t, err)
	assert.NotEqual(t, link.Token, second.Token)
	assert.Equal(t, http.StatusOK, ts.publicNoteStatus(t, second.Token))
	assert.Equal(t, http.StatusNotFound, ts.publicNoteStatus(t, link.Token))

	// Trash pauses the link; restoring brings it back.
	require.NoError(t, owner.Client.DeleteNote(t.Context(), note.ID))
	ts.requirePublicNotFound(t, second.Token)
	_, err = owner.Client.RestoreNote(t.Context(), note.ID)
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, ts.publicNoteStatus(t, second.Token))

	// Archived notes stay visible.
	archived := true
	_, err = owner.Client.UpdateTextNote(t.Context(), note.ID, &client.UpdateTextNoteRequest{Archived: &archived})
	require.NoError(t, err)
	assert.Equal(t, http.StatusOK, ts.publicNoteStatus(t, second.Token))

	// An expired link: 404, null on the note, and the next PUT issues a new token.
	ts.exec(t, `UPDATE note_public_links SET expires_at = ? WHERE note_id = ?`,
		models.Timestamp(models.Now().Add(-time.Minute)), note.ID)
	ts.requirePublicNotFound(t, second.Token)
	expired, err := owner.Client.GetNote(t.Context(), note.ID)
	require.NoError(t, err)
	assert.Nil(t, expired.PublicLink, "an expired link is returned as null")

	third, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
	require.NoError(t, err)
	assert.NotEqual(t, second.Token, third.Token, "an expired link is never revived")
	assert.Equal(t, http.StatusOK, ts.publicNoteStatus(t, third.Token))
	assert.Equal(t, http.StatusNotFound, ts.publicNoteStatus(t, second.Token))

	// Permanent deletion removes the link through the cascade.
	require.NoError(t, owner.Client.DeleteNote(t.Context(), note.ID))
	require.NoError(t, owner.Client.DeleteNotePermanently(t.Context(), note.ID))
	var count int
	require.NoError(t, ts.queryRow(t, `SELECT COUNT(*) FROM note_public_links WHERE note_id = ?`, note.ID).Scan(&count))
	assert.Zero(t, count)
	assert.Equal(t, http.StatusNotFound, ts.publicNoteStatus(t, third.Token))
}

func TestPublicLinkIdempotentPut(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "plidemowner", "password123", false)
	collaborator := ts.createTestUser(t, "plidemcollab", "password123", false)

	note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "packing list"})
	require.NoError(t, err)
	require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collaborator.User.ID))

	t.Run("repeated PUTs return the same link", func(t *testing.T) {
		first, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
		require.NoError(t, err)
		again, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
		require.NoError(t, err)
		assert.Equal(t, first, again)

		// A collaborator's PUT keeps the owner's link and its creator.
		fromCollab, err := collaborator.Client.SetPublicLink(t.Context(), note.ID, nil)
		require.NoError(t, err)
		assert.Equal(t, first, fromCollab)
		require.NoError(t, owner.Client.DeletePublicLink(t.Context(), note.ID))
	})

	t.Run("concurrent PUTs end on one link", func(t *testing.T) {
		const n = 8
		tokens := make([]string, n)
		var wg sync.WaitGroup
		for i := range n {
			user := owner
			if i%2 == 1 {
				user = collaborator
			}
			wg.Go(func() {
				link, err := user.Client.SetPublicLink(t.Context(), note.ID, nil)
				if assert.NoError(t, err) {
					tokens[i] = link.Token
				}
			})
		}
		wg.Wait()
		for _, tok := range tokens {
			assert.Equal(t, tokens[0], tok)
		}
		var count int
		require.NoError(t, ts.queryRow(t, `SELECT COUNT(*) FROM note_public_links WHERE note_id = ?`, note.ID).Scan(&count))
		assert.Equal(t, 1, count)
	})
}

func TestPublicLinkAccess(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "placcowner", "password123", false)
	collaborator := ts.createTestUser(t, "placccollab", "password123", false)
	outsider := ts.createTestUser(t, "placcout", "password123", false)

	note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "shared"})
	require.NoError(t, err)
	require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collaborator.User.ID))

	t.Run("collaborator can create, change the expiry and revoke", func(t *testing.T) {
		link, err := collaborator.Client.SetPublicLink(t.Context(), note.ID, nil)
		require.NoError(t, err)
		require.NotNil(t, link.CreatedBy)
		assert.Equal(t, collaborator.User.ID, *link.CreatedBy)

		ownerView, err := owner.Client.GetNote(t.Context(), note.ID)
		require.NoError(t, err)
		require.NotNil(t, ownerView.PublicLink, "the owner sees the collaborator's link")
		assert.Equal(t, link.Token, ownerView.PublicLink.Token)

		expires := time.Now().Add(30 * 24 * time.Hour)
		changed, err := collaborator.Client.SetPublicLink(t.Context(), note.ID, &expires)
		require.NoError(t, err)
		assert.Equal(t, link.Token, changed.Token)

		require.NoError(t, collaborator.Client.DeletePublicLink(t.Context(), note.ID))
		assert.Equal(t, http.StatusNotFound, ts.publicNoteStatus(t, link.Token))
	})

	t.Run("user without access gets 404 on create, change and revoke", func(t *testing.T) {
		link, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
		require.NoError(t, err)

		_, err = outsider.Client.SetPublicLink(t.Context(), note.ID, nil)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
		expires := time.Now().Add(time.Hour)
		_, err = outsider.Client.SetPublicLink(t.Context(), note.ID, &expires)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
		err = outsider.Client.DeletePublicLink(t.Context(), note.ID)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))

		// Nothing changed.
		current, err := owner.Client.GetNote(t.Context(), note.ID)
		require.NoError(t, err)
		require.NotNil(t, current.PublicLink)
		assert.Equal(t, link.Token, current.PublicLink.Token)
		assert.Nil(t, current.PublicLink.ExpiresAt)
	})

	t.Run("unauthenticated management is 401", func(t *testing.T) {
		_, err := ts.newClient().SetPublicLink(t.Context(), note.ID, nil)
		assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
	})

	t.Run("trashed note: no PUT, but the owner can revoke", func(t *testing.T) {
		require.NoError(t, owner.Client.DeleteNote(t.Context(), note.ID))
		_, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
		err = collaborator.Client.DeletePublicLink(t.Context(), note.ID)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err), "a trashed note is gone for collaborators")
		require.NoError(t, owner.Client.DeletePublicLink(t.Context(), note.ID))
		_, err = owner.Client.RestoreNote(t.Context(), note.ID)
		require.NoError(t, err)
		restored, err := owner.Client.GetNote(t.Context(), note.ID)
		require.NoError(t, err)
		assert.Nil(t, restored.PublicLink)
	})

	t.Run("deleting the creator keeps the link", func(t *testing.T) {
		link, err := collaborator.Client.SetPublicLink(t.Context(), note.ID, nil)
		require.NoError(t, err)
		ts.exec(t, `DELETE FROM users WHERE id = ?`, collaborator.User.ID)

		current, err := owner.Client.GetNote(t.Context(), note.ID)
		require.NoError(t, err)
		require.NotNil(t, current.PublicLink)
		assert.Equal(t, link.Token, current.PublicLink.Token)
		assert.Nil(t, current.PublicLink.CreatedBy)
		assert.Equal(t, http.StatusOK, ts.publicNoteStatus(t, link.Token))
	})
}

func TestPublicLinkValidation(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "plvalowner", "password123", false)

	note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "x"})
	require.NoError(t, err)
	url := ts.HTTPServer.URL + "/api/v1/notes/" + note.ID + "/public-link"

	for _, tt := range []struct{ name, body string }{
		{"expiry in the past", `{"expires_at":"2001-01-01T00:00:00Z"}`},
		{"expiry not RFC 3339", `{"expires_at":"next week"}`},
		{"no body", ``},
	} {
		t.Run(tt.name, func(t *testing.T) {
			status, header, body := rawRequest(t, owner.Client.HTTPClient(), http.MethodPut, url, strings.NewReader(tt.body), jsonHeader)
			requireEnvelope(t, http.StatusBadRequest, "validation_failed", status, header, body)
		})
	}

	t.Run("malformed note ID", func(t *testing.T) {
		status, header, body := rawRequest(t, owner.Client.HTTPClient(), http.MethodPut,
			ts.HTTPServer.URL+"/api/v1/notes/nope/public-link", strings.NewReader(`{"expires_at":null}`), jsonHeader)
		requireEnvelope(t, http.StatusBadRequest, "validation_failed", status, header, body)
	})

	current, err := owner.Client.GetNote(t.Context(), note.ID)
	require.NoError(t, err)
	assert.Nil(t, current.PublicLink, "no rejected request created a link")
}

func TestPublicNoteShape(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "plshapeowner", "password123", false)
	collaborator := ts.createTestUser(t, "plshapecollab", "password123", false)

	t.Run("text note", func(t *testing.T) {
		note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{
			Content: "hello", Color: "#ff0000", Labels: []string{"secret-label"},
		})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collaborator.User.ID))
		link, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
		require.NoError(t, err)

		status, header, body := ts.publicGet(t, link.Token)
		require.Equal(t, http.StatusOK, status, "body: %s", body)
		assert.Equal(t, "noindex", header.Get("X-Robots-Tag"))
		assert.Equal(t, "no-referrer", header.Get("Referrer-Policy"))
		assert.Equal(t, "no-store", header.Get("Cache-Control"))

		var raw map[string]any
		require.NoError(t, json.Unmarshal(body, &raw))
		assert.ElementsMatch(t, []string{"note_type", "title", "updated_at", "image_ids", "content"}, keysOf(raw))
		assert.Equal(t, "text", raw["note_type"])
		assert.Equal(t, "hello", raw["content"])
		assert.Equal(t, []any{}, raw["image_ids"])
		for _, leak := range []string{owner.User.ID, collaborator.User.ID, "plshapeowner", "plshapecollab", "secret-label", "#ff0000", note.ID} {
			assert.NotContains(t, string(body), leak)
		}
	})

	t.Run("empty text note still carries content", func(t *testing.T) {
		note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{})
		require.NoError(t, err)
		link, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
		require.NoError(t, err)

		_, _, body := ts.publicGet(t, link.Token)
		var raw map[string]any
		require.NoError(t, json.Unmarshal(body, &raw))
		assert.Contains(t, raw, "content")
		assert.Empty(t, raw["content"])
	})

	t.Run("list note", func(t *testing.T) {
		note, err := owner.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
			Title: "Groceries",
			Items: []client.CreateNoteItem{
				{Text: "Fruit", Position: 0},
				{Text: "Apples", Position: 1, IndentLevel: 1, Completed: true},
				{Text: "Bread", Position: 2},
			},
		})
		require.NoError(t, err)
		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collaborator.User.ID))
		collapsed := true
		_, err = owner.Client.UpdateListNote(t.Context(), note.ID, &client.UpdateListNoteRequest{CheckedItemsCollapsed: &collapsed})
		require.NoError(t, err)
		// A collaborator's own collapsed state does not leak into the public view.
		expanded := false
		_, err = collaborator.Client.UpdateListNote(t.Context(), note.ID, &client.UpdateListNoteRequest{CheckedItemsCollapsed: &expanded})
		require.NoError(t, err)

		link, err := collaborator.Client.SetPublicLink(t.Context(), note.ID, nil)
		require.NoError(t, err)

		status, _, body := ts.publicGet(t, link.Token)
		require.Equal(t, http.StatusOK, status, "body: %s", body)
		var raw map[string]any
		require.NoError(t, json.Unmarshal(body, &raw))
		assert.ElementsMatch(t, []string{"note_type", "title", "updated_at", "image_ids", "items", "checked_items_collapsed"}, keysOf(raw))
		items, ok := raw["items"].([]any)
		require.True(t, ok)
		require.Len(t, items, 3)
		for _, it := range items {
			item, ok := it.(map[string]any)
			require.True(t, ok)
			assert.ElementsMatch(t, []string{"id", "text", "completed", "parent_id", "position"}, keysOf(item))
		}

		pub, err := ts.newClient().GetPublicNote(t.Context(), link.Token)
		require.NoError(t, err)
		assert.Equal(t, client.NoteTypeList, pub.NoteType)
		assert.Equal(t, "Groceries", pub.Title)
		assert.Nil(t, pub.Content)
		require.NotNil(t, pub.CheckedItemsCollapsed)
		assert.True(t, *pub.CheckedItemsCollapsed, "the owner's collapsed state is the public one")
		byText := map[string]client.PublicNoteItem{}
		for _, it := range pub.Items {
			byText[it.Text] = it
		}
		require.NotNil(t, byText["Apples"].ParentID)
		assert.Equal(t, byText["Fruit"].ID, *byText["Apples"].ParentID)
		assert.True(t, byText["Apples"].Completed)
		assert.Nil(t, byText["Bread"].ParentID)
	})
}

func keysOf(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

func TestPublicLinkImages(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "plimgowner", "password123", false)
	anon := ts.newClient()

	note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "with image"})
	require.NoError(t, err)
	other, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "private"})
	require.NoError(t, err)

	img, err := owner.Client.UploadNoteImage(t.Context(), note.ID, "cat.png", bytes.NewReader(testPNG(t, 8, 8)))
	require.NoError(t, err)
	otherImg, err := owner.Client.UploadNoteImage(t.Context(), other.ID, "dog.png", bytes.NewReader(testPNG(t, 9, 9)))
	require.NoError(t, err)

	link, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
	require.NoError(t, err)

	pub, err := anon.GetPublicNote(t.Context(), link.Token)
	require.NoError(t, err)
	assert.Equal(t, []string{img.ID}, pub.ImageIDs)

	t.Run("the note's image and thumbnail are served, uncached", func(t *testing.T) {
		for _, suffix := range []string{"", "/thumbnail"} {
			status, header, body := ts.publicGet(t, link.Token+"/images/"+img.ID+suffix)
			require.Equal(t, http.StatusOK, status, "suffix %q: %s", suffix, body)
			assert.NotEmpty(t, body)
			assert.Equal(t, "no-store", header.Get("Cache-Control"))
			assert.NotContains(t, header.Get("Cache-Control"), "immutable")
			assert.Equal(t, "noindex", header.Get("X-Robots-Tag"))
			assert.Equal(t, "no-referrer", header.Get("Referrer-Policy"))
			assert.Equal(t, "nosniff", header.Get("X-Content-Type-Options"))
		}
		data, contentType, err := anon.GetPublicNoteImage(t.Context(), link.Token, img.ID)
		require.NoError(t, err)
		assert.Equal(t, "image/png", contentType)
		assert.Equal(t, testPNG(t, 8, 8), data)
		_, contentType, err = anon.GetPublicNoteImageThumbnail(t.Context(), link.Token, img.ID)
		require.NoError(t, err)
		assert.Equal(t, "image/jpeg", contentType)
	})

	t.Run("any other image returns the same 404", func(t *testing.T) {
		missingID, err := models.GenerateID()
		require.NoError(t, err)
		for _, id := range []string{otherImg.ID, missingID, "not-an-id"} {
			for _, suffix := range []string{"", "/thumbnail"} {
				ts.requirePublicNotFound(t, link.Token+"/images/"+id+suffix)
			}
		}
	})

	t.Run("images stop with the link", func(t *testing.T) {
		require.NoError(t, owner.Client.DeletePublicLink(t.Context(), note.ID))
		for _, suffix := range []string{"", "/thumbnail"} {
			ts.requirePublicNotFound(t, link.Token+"/images/"+img.ID+suffix)
		}
	})
}

// TestPublicLinkIdenticalNotFound checks that every way a public link can be
// dead answers with exactly the same 404, so a visitor learns nothing about
// which it was.
func TestPublicLinkIdenticalNotFound(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "pl404owner", "password123", false)

	newLinkedNote := func(t *testing.T) (string, string) {
		t.Helper()
		note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "x"})
		require.NoError(t, err)
		link, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
		require.NoError(t, err)
		return note.ID, link.Token
	}

	_, liveToken := newLinkedNote(t)
	revokedNote, revokedToken := newLinkedNote(t)
	require.NoError(t, owner.Client.DeletePublicLink(t.Context(), revokedNote))
	expiredNote, expiredToken := newLinkedNote(t)
	ts.exec(t, `UPDATE note_public_links SET expires_at = ? WHERE note_id = ?`,
		models.Timestamp(models.Now().Add(-time.Second)), expiredNote)
	trashedNote, trashedToken := newLinkedNote(t)
	require.NoError(t, owner.Client.DeleteNote(t.Context(), trashedNote))
	imgNote, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "img"})
	require.NoError(t, err)
	foreignImg, err := owner.Client.UploadNoteImage(t.Context(), imgNote.ID, "a.png", bytes.NewReader(testPNG(t, 2, 2)))
	require.NoError(t, err)

	unknownToken := strings.Repeat("A", 43)
	cases := map[string]string{
		"unknown":               unknownToken,
		"revoked":               revokedToken,
		"expired":               expiredToken,
		"trashed note":          trashedToken,
		"too short":             liveToken[:42],
		"too long":              liveToken + "A",
		"bad character":         liveToken[:42] + "~",
		"plus sign":             liveToken[:42] + "+",
		"escaped character":     liveToken[:40] + "%20A",
		"empty-looking":         "%20",
		"SQL-looking":           "x'%20OR%20'1'='1",
		"foreign image":         liveToken + "/images/" + foreignImg.ID,
		"foreign thumbnail":     liveToken + "/images/" + foreignImg.ID + "/thumbnail",
		"image under dead link": revokedToken + "/images/" + foreignImg.ID,
	}

	var want []byte
	for name, path := range cases {
		t.Run(name, func(t *testing.T) {
			body := ts.requirePublicNotFound(t, path)
			if want == nil {
				want = body
			}
			assert.Equal(t, string(want), string(body))
		})
	}
	assert.Equal(t, http.StatusOK, ts.publicNoteStatus(t, liveToken))
}

func TestPublicLinkSwitchOff(t *testing.T) {
	t.Parallel()

	// Two servers on one database stand in for restarting with the switch
	// flipped: on keeps the defaults, off has JOT_PUBLIC_LINKS_ENABLED=false.
	var shared *config.Config
	on := setupTestServerWithConfig(t, func(cfg *config.Config) { shared = cfg })
	off := setupTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.DBDSN = shared.DBDSN
		cfg.UploadDir = shared.UploadDir
		cfg.PublicLinksEnabled = false
	})

	owner := on.createTestUser(t, "plswitchowner", "password123", false)
	note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "x"})
	require.NoError(t, err)
	img, err := owner.Client.UploadNoteImage(t.Context(), note.ID, "a.png", bytes.NewReader(testPNG(t, 2, 2)))
	require.NoError(t, err)
	link, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
	require.NoError(t, err)

	offOwner := off.newClient()
	_, err = offOwner.Login(t.Context(), "plswitchowner", "password123")
	require.NoError(t, err)

	cfgOn, err := on.newClient().Config(t.Context())
	require.NoError(t, err)
	assert.True(t, cfgOn.PublicLinksEnabled)
	cfgOff, err := offOwner.Config(t.Context())
	require.NoError(t, err)
	assert.False(t, cfgOff.PublicLinksEnabled)

	t.Run("public endpoints 404", func(t *testing.T) {
		off.requirePublicNotFound(t, link.Token)
		off.requirePublicNotFound(t, link.Token+"/images/"+img.ID)
		off.requirePublicNotFound(t, link.Token+"/images/"+img.ID+"/thumbnail")
	})

	t.Run("PUT is 403", func(t *testing.T) {
		_, err := offOwner.SetPublicLink(t.Context(), note.ID, nil)
		assert.Equal(t, http.StatusForbidden, client.StatusCode(err))
		assert.Equal(t, "public_links_disabled", client.ErrorCode(err))
	})

	t.Run("existing links are kept and come back when switched on", func(t *testing.T) {
		current, err := offOwner.GetNote(t.Context(), note.ID)
		require.NoError(t, err)
		require.NotNil(t, current.PublicLink)
		assert.Equal(t, link.Token, current.PublicLink.Token)
		assert.Equal(t, http.StatusOK, on.publicNoteStatus(t, link.Token))
	})

	t.Run("DELETE still works", func(t *testing.T) {
		require.NoError(t, offOwner.DeletePublicLink(t.Context(), note.ID))
		assert.Equal(t, http.StatusNotFound, on.publicNoteStatus(t, link.Token))
	})
}

func TestPublicLinkDuplicateDoesNotCopy(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "pldupowner", "password123", false)

	note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "x"})
	require.NoError(t, err)
	_, err = owner.Client.SetPublicLink(t.Context(), note.ID, nil)
	require.NoError(t, err)

	dup, err := owner.Client.DuplicateNote(t.Context(), note.ID)
	require.NoError(t, err)
	assert.Nil(t, dup.PublicLink)
	fetched, err := owner.Client.GetNote(t.Context(), dup.ID)
	require.NoError(t, err)
	assert.Nil(t, fetched.PublicLink)
}

func TestPublicLinkSSE(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "plsseowner", "password123", false)
	collaborator := ts.createTestUser(t, "plssecollab", "password123", false)

	note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "shared"})
	require.NoError(t, err)
	require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collaborator.User.ID))

	sseCtx, sseCancel := context.WithCancel(t.Context())
	t.Cleanup(sseCancel)
	collabCh, err := collaborator.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)
	ownerCh, err := owner.Client.SubscribeSSE(sseCtx)
	require.NoError(t, err)

	isUpdate := func(e client.SSEEvent) bool {
		return e.Type == string(sse.EventNoteUpdated) && e.SourceUserID == owner.User.ID &&
			e.NoteData != nil && e.NoteData.NoteID == note.ID && e.NoteData.Note != nil
	}

	link, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
	require.NoError(t, err)
	for name, ch := range map[string]<-chan client.SSEEvent{"collaborator": collabCh, "owner": ownerCh} {
		event, found := waitForSSEEvent(ch, isUpdate, 3*time.Second)
		require.True(t, found, "%s should receive note_updated when a link is created", name)
		require.NotNil(t, event.NoteData.Note.PublicLink)
		assert.Equal(t, link.Token, event.NoteData.Note.PublicLink.Token)
	}

	expires := time.Now().Add(time.Hour)
	_, err = owner.Client.SetPublicLink(t.Context(), note.ID, &expires)
	require.NoError(t, err)
	event, found := waitForSSEEvent(collabCh, isUpdate, 3*time.Second)
	require.True(t, found, "collaborator should receive note_updated when the expiry changes")
	require.NotNil(t, event.NoteData.Note.PublicLink)
	assert.NotNil(t, event.NoteData.Note.PublicLink.ExpiresAt)

	require.NoError(t, owner.Client.DeletePublicLink(t.Context(), note.ID))
	event, found = waitForSSEEvent(collabCh, isUpdate, 3*time.Second)
	require.True(t, found, "collaborator should receive note_updated when the link is revoked")
	assert.Nil(t, event.NoteData.Note.PublicLink)

	// Revoking a trashed note's link reaches the owner, the only one who sees it.
	_, err = owner.Client.SetPublicLink(t.Context(), note.ID, nil)
	require.NoError(t, err)
	require.NoError(t, owner.Client.DeleteNote(t.Context(), note.ID))
	require.NoError(t, owner.Client.DeletePublicLink(t.Context(), note.ID))
	event, found = waitForSSEEvent(ownerCh, func(e client.SSEEvent) bool {
		return isUpdate(e) && e.NoteData.Note.DeletedAt != nil
	}, 3*time.Second)
	require.True(t, found, "owner should receive note_updated when a trashed note's link is revoked")
	assert.Nil(t, event.NoteData.Note.PublicLink)
}

func TestPublicLinkConfig(t *testing.T) {
	t.Parallel()

	t.Run("public_url is null when unset", func(t *testing.T) {
		ts := setupTestServer(t)
		cfg, err := ts.newClient().Config(t.Context())
		require.NoError(t, err)
		assert.Nil(t, cfg.PublicURL)
		assert.True(t, cfg.PublicLinksEnabled)

		_, _, body := rawRequest(t, ts.httpClient, http.MethodGet, ts.HTTPServer.URL+"/api/v1/config", nil, nil)
		assert.Contains(t, string(body), `"public_url":null`)
	})

	t.Run("public_url is the configured origin", func(t *testing.T) {
		ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
			cfg.PublicURL = "https://jot.example.com"
		})
		cfg, err := ts.newClient().Config(t.Context())
		require.NoError(t, err)
		require.NotNil(t, cfg.PublicURL)
		assert.Equal(t, "https://jot.example.com", *cfg.PublicURL)
	})
}

func TestPublicLinkSharePageHeaders(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)

	t.Run("share page", func(t *testing.T) {
		status, header, body := rawRequest(t, ts.httpClient, http.MethodGet, ts.HTTPServer.URL+"/share/"+strings.Repeat("a", 43), nil, nil)
		require.Equal(t, http.StatusOK, status)
		assert.Contains(t, string(body), "jot test app", "the SPA serves the viewer page")
		assert.Equal(t, "noindex", header.Get("X-Robots-Tag"))
		assert.Equal(t, "no-referrer", header.Get("Referrer-Policy"))
	})

	t.Run("other pages keep the global policy", func(t *testing.T) {
		status, header, _ := rawRequest(t, ts.httpClient, http.MethodGet, ts.HTTPServer.URL+"/notes/abc", nil, nil)
		require.Equal(t, http.StatusOK, status)
		assert.Empty(t, header.Get("X-Robots-Tag"))
		assert.Equal(t, "strict-origin-when-cross-origin", header.Get("Referrer-Policy"))
	})
}
