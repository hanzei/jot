package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const testIndex = "<!doctype html>spa index"

// testBundle is long enough that gzip visibly shrinks it.
var testBundle = strings.Repeat("const jot = 'app bundle';\n", 200)

// newTestFileServer serves a small build (index.html, a script and an image)
// through FileServer and returns a GET helper for it.
func newTestFileServer(t *testing.T) func(t *testing.T, path string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()

	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "index.html"), []byte(testIndex), 0o600))
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "assets"), 0o750))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "assets", "app.js"), []byte(testBundle), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "assets", "icon.png"), []byte("\x89PNG\r\n\x1a\nnot really"), 0o600))

	root, err := os.OpenRoot(dir)
	require.NoError(t, err)
	t.Cleanup(func() { _ = root.Close() })

	r := chi.NewRouter()
	FileServer(r, "/", root)

	return func(t *testing.T, path string, headers map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}
}

func TestFileServer(t *testing.T) {
	t.Parallel()

	get := newTestFileServer(t)

	tests := []struct {
		name string
		path string
		body string
	}{
		{name: "root serves index.html", path: "/", body: testIndex},
		{name: "existing file is served", path: "/assets/app.js", body: testBundle},
		{name: "unknown path falls back to index.html", path: "/notes/abc", body: testIndex},
		{name: "directory falls back to index.html instead of listing it", path: "/assets/", body: testIndex},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			rec := get(t, tt.path, nil)
			assert.Equal(t, http.StatusOK, rec.Code)
			assert.Equal(t, tt.body, rec.Body.String())
		})
	}
}

func TestFileServerCompression(t *testing.T) {
	t.Parallel()

	get := newTestFileServer(t)
	acceptGzip := map[string]string{"Accept-Encoding": "gzip"}

	tests := []struct {
		name     string
		path     string
		headers  map[string]string
		wantGzip bool
		// wantBody is compared after decompressing; empty skips the check.
		wantBody string
	}{
		{name: "script is gzipped when the client accepts it", path: "/assets/app.js", headers: acceptGzip, wantGzip: true, wantBody: testBundle},
		{name: "SPA fallback is gzipped", path: "/notes/abc", headers: acceptGzip, wantGzip: true, wantBody: testIndex},
		{name: "served plain without Accept-Encoding", path: "/assets/app.js", wantBody: testBundle},
		{name: "image is not recompressed", path: "/assets/icon.png", headers: acceptGzip},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			rec := get(t, tt.path, tt.headers)
			require.Equal(t, http.StatusOK, rec.Code)

			body := rec.Body.String()
			if tt.wantGzip {
				assert.Equal(t, "gzip", rec.Header().Get("Content-Encoding"))
				assert.Contains(t, rec.Header().Values("Vary"), "Accept-Encoding")
				assert.Empty(t, rec.Header().Get("Content-Length"))
				// Ranges are only served uncompressed, so a gzipped body must not advertise them.
				assert.Empty(t, rec.Header().Get("Accept-Ranges"))
				zr, err := gzip.NewReader(rec.Body)
				require.NoError(t, err)
				b, err := io.ReadAll(zr)
				require.NoError(t, err)
				body = string(b)
			} else {
				assert.Empty(t, rec.Header().Get("Content-Encoding"))
				assert.Equal(t, "bytes", rec.Header().Get("Accept-Ranges"))
			}
			if tt.wantBody != "" {
				assert.Equal(t, tt.wantBody, body)
			}
		})
	}

	t.Run("range request is answered uncompressed", func(t *testing.T) {
		t.Parallel()
		rec := get(t, "/assets/app.js", map[string]string{"Accept-Encoding": "gzip", "Range": "bytes=0-4"})
		assert.Equal(t, http.StatusPartialContent, rec.Code)
		assert.Empty(t, rec.Header().Get("Content-Encoding"))
		assert.Equal(t, testBundle[:5], rec.Body.String())
	})

	t.Run("not modified has no body", func(t *testing.T) {
		t.Parallel()
		lastModified := get(t, "/assets/app.js", nil).Header().Get("Last-Modified")
		require.NotEmpty(t, lastModified)
		rec := get(t, "/assets/app.js", map[string]string{"Accept-Encoding": "gzip", "If-Modified-Since": lastModified})
		assert.Equal(t, http.StatusNotModified, rec.Code)
		assert.Zero(t, rec.Body.Len())
	})
}
