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

func TestFileServer(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "index.html"), []byte("spa index"), 0o600))
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "assets"), 0o750))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "assets", "app.js"), []byte("app bundle"), 0o600))

	root, err := os.OpenRoot(dir)
	require.NoError(t, err)
	t.Cleanup(func() { _ = root.Close() })

	r := chi.NewRouter()
	FileServer(r, "/", root)

	get := func(t *testing.T, path string) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil))
		return rec
	}

	tests := []struct {
		name string
		path string
		body string
	}{
		{name: "root serves index.html", path: "/", body: "spa index"},
		{name: "existing file is served", path: "/assets/app.js", body: "app bundle"},
		{name: "unknown path falls back to index.html", path: "/notes/abc", body: "spa index"},
		{name: "directory falls back to index.html instead of listing it", path: "/assets/", body: "spa index"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			rec := get(t, tt.path)
			assert.Equal(t, http.StatusOK, rec.Code)
			assert.Equal(t, tt.body, rec.Body.String())
		})
	}
}

func TestFileServerCompression(t *testing.T) {
	t.Parallel()

	bundle := strings.Repeat("const jot = 'app bundle';\n", 200)
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html>spa index"), 0o600))
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "assets"), 0o750))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "assets", "app.js"), []byte(bundle), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "assets", "icon.png"), []byte("\x89PNG\r\n\x1a\nnot really"), 0o600))

	root, err := os.OpenRoot(dir)
	require.NoError(t, err)
	t.Cleanup(func() { _ = root.Close() })

	r := chi.NewRouter()
	FileServer(r, "/", root)

	get := func(t *testing.T, path string, headers map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec
	}
	gunzip := func(t *testing.T, rec *httptest.ResponseRecorder) string {
		t.Helper()
		zr, err := gzip.NewReader(rec.Body)
		require.NoError(t, err)
		b, err := io.ReadAll(zr)
		require.NoError(t, err)
		return string(b)
	}

	t.Run("script is gzipped when the client accepts it", func(t *testing.T) {
		t.Parallel()
		rec := get(t, "/assets/app.js", map[string]string{"Accept-Encoding": "gzip"})
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "gzip", rec.Header().Get("Content-Encoding"))
		assert.Contains(t, rec.Header().Values("Vary"), "Accept-Encoding")
		assert.Empty(t, rec.Header().Get("Content-Length"))
		assert.Less(t, rec.Body.Len(), len(bundle))
		assert.Equal(t, bundle, gunzip(t, rec))
	})

	t.Run("SPA fallback is gzipped", func(t *testing.T) {
		t.Parallel()
		rec := get(t, "/notes/abc", map[string]string{"Accept-Encoding": "gzip"})
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "gzip", rec.Header().Get("Content-Encoding"))
		assert.Equal(t, "<!doctype html>spa index", gunzip(t, rec))
	})

	t.Run("served plain without Accept-Encoding", func(t *testing.T) {
		t.Parallel()
		rec := get(t, "/assets/app.js", nil)
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Empty(t, rec.Header().Get("Content-Encoding"))
		assert.Equal(t, bundle, rec.Body.String())
	})

	t.Run("image is not recompressed", func(t *testing.T) {
		t.Parallel()
		rec := get(t, "/assets/icon.png", map[string]string{"Accept-Encoding": "gzip"})
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Empty(t, rec.Header().Get("Content-Encoding"))
	})

	t.Run("range request is answered uncompressed", func(t *testing.T) {
		t.Parallel()
		rec := get(t, "/assets/app.js", map[string]string{"Accept-Encoding": "gzip", "Range": "bytes=0-4"})
		assert.Equal(t, http.StatusPartialContent, rec.Code)
		assert.Empty(t, rec.Header().Get("Content-Encoding"))
		assert.Equal(t, bundle[:5], rec.Body.String())
	})

	t.Run("not modified has no body", func(t *testing.T) {
		t.Parallel()
		first := get(t, "/assets/app.js", nil)
		lastModified := first.Header().Get("Last-Modified")
		require.NotEmpty(t, lastModified)
		rec := get(t, "/assets/app.js", map[string]string{"Accept-Encoding": "gzip", "If-Modified-Since": lastModified})
		assert.Equal(t, http.StatusNotModified, rec.Code)
		assert.Zero(t, rec.Body.Len())
	})
}
