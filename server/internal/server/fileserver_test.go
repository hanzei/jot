package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
