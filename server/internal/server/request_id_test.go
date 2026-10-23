package server

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestRequestIDHeader checks that every response carries X-Request-Id and that
// it is the request_id the request log line was written with.
func TestRequestIDHeader(t *testing.T) {
	t.Parallel()

	tmpDir := t.TempDir()
	cfg := &config.Config{
		DBDriver:          "sqlite",
		DBDSN:             tmpDir + "/test.db",
		StaticDir:         tmpDir,
		UploadDir:         tmpDir + "/uploads",
		UploadMaxBytes:    25 << 20,
		PasswordMinLength: 10,
		LocalLoginEnabled: true,
	}
	log, hook := newCapturingLogger()
	s, err := NewWithLogger(cfg, log)
	require.NoError(t, err)
	t.Cleanup(func() {
		s.StopBackgroundTasks()
		_ = s.GetDB().Close()
	})

	generated := regexp.MustCompile(`^[0-9a-f]{16}$`)

	tests := []struct {
		name     string
		method   string
		path     string
		incoming string
		status   int
		want     string // "" means a generated ID is expected
	}{
		{name: "success", method: http.MethodGet, path: "/api/v1/config", status: http.StatusOK},
		{name: "api error", method: http.MethodGet, path: "/api/v1/notes", status: http.StatusUnauthorized},
		{name: "unknown route", method: http.MethodGet, path: "/api/v1/nope", status: http.StatusNotFound},
		{name: "health probe", method: http.MethodGet, path: "/livez", status: http.StatusOK},
		{name: "valid incoming id is kept", method: http.MethodGet, path: "/api/v1/config", incoming: "client-abc_1.2", status: http.StatusOK, want: "client-abc_1.2"},
		{name: "incoming id with bad characters is replaced", method: http.MethodGet, path: "/api/v1/config", incoming: "bad id\tvalue", status: http.StatusOK},
		{name: "overlong incoming id is replaced", method: http.MethodGet, path: "/api/v1/config", incoming: strings.Repeat("a", maxRequestIDLen+1), status: http.StatusOK},
		{name: "incoming id at the length cap is kept", method: http.MethodGet, path: "/api/v1/config", incoming: strings.Repeat("a", maxRequestIDLen), status: http.StatusOK, want: strings.Repeat("a", maxRequestIDLen)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hook.Reset()
			req := httptest.NewRequestWithContext(t.Context(), tt.method, tt.path, nil)
			if tt.incoming != "" {
				req.Header.Set(requestIDHeader, tt.incoming)
			}
			rec := httptest.NewRecorder()
			s.GetRouter().ServeHTTP(rec, req)

			require.Equal(t, tt.status, rec.Code)
			id := rec.Header().Get(requestIDHeader)
			if tt.want != "" {
				assert.Equal(t, tt.want, id)
			} else {
				assert.Regexp(t, generated, id)
			}

			var logged []any
			for _, e := range hook.AllEntries() {
				if e.Message == "Request completed" {
					logged = append(logged, e.Data["request_id"])
				}
			}
			assert.Equal(t, []any{id}, logged)
		})
	}

	t.Run("generated ids differ", func(t *testing.T) {
		ids := map[string]bool{}
		for range 20 {
			rec := httptest.NewRecorder()
			s.GetRouter().ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/livez", nil))
			ids[rec.Header().Get(requestIDHeader)] = true
		}
		assert.Len(t, ids, 20)
	})
}
