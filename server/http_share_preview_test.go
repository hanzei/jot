package main

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Link preview cards for public links (#1209).

// setupSharePreviewServer starts a test server that serves the real
// webapp/index.html, preview markers included, and returns that file.
func setupSharePreviewServer(t *testing.T, customize func(*config.Config)) (*TestServer, []byte) {
	t.Helper()
	index, err := os.ReadFile("../webapp/index.html")
	require.NoError(t, err)
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
		require.NoError(t, os.WriteFile(cfg.StaticDir+"/index.html", index, 0o600)) // #nosec G703 -- StaticDir is the harness's own t.TempDir()
		if customize != nil {
			customize(cfg)
		}
	})
	return ts, index
}

// sharePage fetches path anonymously and returns the page, failing unless it
// is a 200 HTML page.
func (ts *TestServer) sharePage(t *testing.T, path string) string {
	t.Helper()
	status, header, body := rawRequest(t, ts.httpClient, http.MethodGet, ts.HTTPServer.URL+path, nil, nil)
	require.Equal(t, http.StatusOK, status, "%s: %s", path, body)
	assert.True(t, strings.HasPrefix(header.Get("Content-Type"), "text/html"), "%s: %s", path, header.Get("Content-Type"))
	return string(body)
}

func TestSharePreviewCard(t *testing.T) {
	t.Parallel()
	ts, index := setupSharePreviewServer(t, nil)
	owner := ts.createTestUser(t, "previewowner", "password123", false)
	genericDescription := `<meta name="description" content="Jot is a self-hosted app for notes, lists and tasks." />`
	require.Contains(t, string(index), genericDescription)

	t.Run("list note: escaped title, generic description, no content", func(t *testing.T) {
		note, err := owner.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
			Title: `Groceries "><script>alert(1)</script>`,
			Items: []client.CreateNoteItem{{Text: "secret item text"}},
		})
		require.NoError(t, err)
		link, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
		require.NoError(t, err)

		page := ts.sharePage(t, "/share/"+link.Token)
		escaped := "Groceries &#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"
		assert.Contains(t, page, "<title>"+escaped+"</title>")
		assert.Contains(t, page, `<meta property="og:title" content="`+escaped+`" />`)
		assert.NotContains(t, page, "<script>alert(1)")
		assert.Contains(t, page, `<meta property="og:url" content="/share/`+link.Token+`" />`)
		assert.Contains(t, page, genericDescription, "the description stays generic")
		assert.NotContains(t, page, "secret item text")
		// No images: the app icon card stays.
		assert.Contains(t, page, `<meta property="og:image" content="/pwa-512x512.png" />`)
		assert.Contains(t, page, `<meta property="og:image:alt" content="The Jot app icon" />`)
		// The page is still the SPA, so the viewer loads.
		assert.Contains(t, page, `<div id="root"></div>`)
	})

	t.Run("text note: fallback title, no content", func(t *testing.T) {
		note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "secret body text"})
		require.NoError(t, err)
		link, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
		require.NoError(t, err)

		page := ts.sharePage(t, "/share/"+link.Token)
		assert.Contains(t, page, "<title>Shared note</title>")
		assert.Contains(t, page, `<meta property="og:title" content="Shared note" />`)
		assert.NotContains(t, page, "secret body text")
		assert.Contains(t, page, genericDescription)
	})

	t.Run("blank list title gets the fallback", func(t *testing.T) {
		note, err := owner.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{Title: "   "})
		require.NoError(t, err)
		link, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
		require.NoError(t, err)
		assert.Contains(t, ts.sharePage(t, "/share/"+link.Token), "<title>Shared note</title>")
	})

	t.Run("first image is the earliest, with its thumbnail size", func(t *testing.T) {
		note, err := owner.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{Title: "Trip"})
		require.NoError(t, err)
		later, err := owner.Client.UploadNoteImage(t.Context(), note.ID, "later.png", bytes.NewReader(testPNG(t, 8, 8)))
		require.NoError(t, err)
		first, err := owner.Client.UploadNoteImage(t.Context(), note.ID, "first.png", bytes.NewReader(testPNG(t, 1024, 640)))
		require.NoError(t, err)
		// Uploaded second but created first: the card follows created_at,
		// the order the app shows images in.
		ts.exec(t, `UPDATE note_images SET created_at = ? WHERE id = ?`,
			models.Timestamp(models.Now().Add(-time.Hour)), first.ID)
		link, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
		require.NoError(t, err)

		page := ts.sharePage(t, "/share/"+link.Token)
		thumbnail := "/api/v1/public/notes/" + link.Token + "/images/" + first.ID + "/thumbnail"
		assert.Contains(t, page, `<meta property="og:image" content="`+thumbnail+`" />`)
		assert.NotContains(t, page, later.ID)
		assert.NotContains(t, page, "pwa-512x512.png")
		assert.Contains(t, page, `<meta property="og:image:type" content="image/jpeg" />`)
		assert.Contains(t, page, `<meta property="og:image:width" content="512" />`)
		assert.Contains(t, page, `<meta property="og:image:height" content="320" />`)
		assert.Contains(t, page, `<meta property="og:image:alt" content="Trip" />`)

		// The tags describe the thumbnail the preview service then fetches.
		status, header, _ := rawRequest(t, ts.httpClient, http.MethodGet, ts.HTTPServer.URL+thumbnail, nil, nil)
		require.Equal(t, http.StatusOK, status)
		assert.Equal(t, "image/jpeg", header.Get("Content-Type"))
	})

	t.Run("share page keeps its headers and is gzipped", func(t *testing.T) {
		note, err := owner.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{Title: "Zipped"})
		require.NoError(t, err)
		link, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
		require.NoError(t, err)

		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/share/"+link.Token, nil)
		require.NoError(t, err)
		req.Header.Set("Accept-Encoding", "gzip")
		// A Transport that sees Accept-Encoding set by the caller leaves the
		// body compressed.
		resp, err := ts.httpClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Equal(t, "gzip", resp.Header.Get("Content-Encoding"))
		assert.Equal(t, "noindex", resp.Header.Get("X-Robots-Tag"))
		assert.Equal(t, "no-referrer", resp.Header.Get("Referrer-Policy"))
		_, err = io.Copy(io.Discard, resp.Body)
		require.NoError(t, err)
	})
}

// TestSharePreviewGenericPages checks that every dead link and every path
// outside /share/ gets index.html byte for byte, so a dead link does not
// reveal why it is dead.
func TestSharePreviewGenericPages(t *testing.T) {
	t.Parallel()
	ts, index := setupSharePreviewServer(t, nil)
	owner := ts.createTestUser(t, "previewdead", "password123", false)

	newLinkedNote := func(t *testing.T) (string, string) {
		t.Helper()
		note, err := owner.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{Title: "Private title"})
		require.NoError(t, err)
		link, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
		require.NoError(t, err)
		return note.ID, link.Token
	}

	liveNote, liveToken := newLinkedNote(t)
	revokedNote, revokedToken := newLinkedNote(t)
	require.NoError(t, owner.Client.DeletePublicLink(t.Context(), revokedNote))
	expiredNote, expiredToken := newLinkedNote(t)
	ts.exec(t, `UPDATE note_public_links SET expires_at = ? WHERE note_id = ?`,
		models.Timestamp(models.Now().Add(-time.Second)), expiredNote)
	trashedNote, trashedToken := newLinkedNote(t)
	require.NoError(t, owner.Client.DeleteNote(t.Context(), trashedNote))

	paths := map[string]string{
		"unknown token":       "/share/" + strings.Repeat("A", 43),
		"revoked":             "/share/" + revokedToken,
		"expired":             "/share/" + expiredToken,
		"trashed note":        "/share/" + trashedToken,
		"too short":           "/share/" + liveToken[:42],
		"bad character":       "/share/" + liveToken[:42] + "~",
		"extra segment":       "/share/" + liveToken + "/x",
		"trailing slash":      "/share/" + liveToken + "/",
		"no token":            "/share/",
		"note page":           "/notes/" + liveNote,
		"root":                "/",
		"login":               "/login",
		"token outside share": "/notes/" + liveToken,
	}
	for name, path := range paths {
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, string(index), ts.sharePage(t, path))
		})
	}
	assert.Contains(t, ts.sharePage(t, "/share/"+liveToken), "<title>Private title</title>", "the live link still gets its card")
}

func TestSharePreviewSwitchOff(t *testing.T) {
	t.Parallel()
	var shared *config.Config
	on, index := setupSharePreviewServer(t, func(cfg *config.Config) { shared = cfg })
	off, _ := setupSharePreviewServer(t, func(cfg *config.Config) {
		cfg.DBDSN = shared.DBDSN
		cfg.UploadDir = shared.UploadDir
		cfg.PublicLinksEnabled = false
	})
	owner := on.createTestUser(t, "previewswitch", "password123", false)
	note, err := owner.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{Title: "Switched"})
	require.NoError(t, err)
	link, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
	require.NoError(t, err)

	assert.Contains(t, on.sharePage(t, "/share/"+link.Token), "<title>Switched</title>")
	assert.Equal(t, string(index), off.sharePage(t, "/share/"+link.Token))
}

func TestSharePreviewPublicURL(t *testing.T) {
	t.Parallel()

	for _, tt := range []struct {
		name      string
		publicURL string
	}{
		{name: "relative without JOT_PUBLIC_URL", publicURL: ""},
		{name: "absolute with JOT_PUBLIC_URL", publicURL: "https://jot.example.com"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			ts, _ := setupSharePreviewServer(t, func(cfg *config.Config) { cfg.PublicURL = tt.publicURL })
			owner := ts.createTestUser(t, "previewurl", "password123", false)
			note, err := owner.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{Title: "Absolute"})
			require.NoError(t, err)
			img, err := owner.Client.UploadNoteImage(t.Context(), note.ID, "a.png", bytes.NewReader(testPNG(t, 4, 4)))
			require.NoError(t, err)
			link, err := owner.Client.SetPublicLink(t.Context(), note.ID, nil)
			require.NoError(t, err)

			wantURL := `<meta property="og:url" content="` + tt.publicURL + "/share/" + link.Token + `" />`
			wantImage := `<meta property="og:image" content="` + tt.publicURL + "/api/v1/public/notes/" + link.Token + "/images/" + img.ID + `/thumbnail" />`

			for _, host := range []string{"", "evil.example.org"} {
				req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/share/"+link.Token, nil)
				require.NoError(t, err)
				if host != "" {
					req.Host = host
					req.Header.Set("X-Forwarded-Host", host)
				}
				resp, err := ts.httpClient.Do(req)
				require.NoError(t, err)
				body, err := io.ReadAll(resp.Body)
				require.NoError(t, resp.Body.Close())
				require.NoError(t, err)
				require.Equal(t, http.StatusOK, resp.StatusCode)

				page := string(body)
				assert.Contains(t, page, wantURL, "host %q", host)
				assert.Contains(t, page, wantImage, "host %q", host)
				assert.NotContains(t, page, "evil.example.org")
				assert.Contains(t, page, `<meta property="og:image:width" content="4" />`)
			}
		})
	}
}
