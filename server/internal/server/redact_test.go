package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/internal/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestRedactTokenPath(t *testing.T) {
	t.Parallel()

	tok := strings.Repeat("x", 43)
	for _, tt := range []struct {
		path, want string
		redacted   bool
	}{
		{"/api/v1/public/notes/" + tok, "/api/v1/public/notes/{token}", true},
		{"/api/v1/public/notes/" + tok + "/images/abc", "/api/v1/public/notes/{token}/images/abc", true},
		{"/api/v1/public/notes/" + tok + "/images/abc/thumbnail", "/api/v1/public/notes/{token}/images/abc/thumbnail", true},
		{"/share/" + tok, "/share/{token}", true},
		{"/share/" + tok + "/", "/share/{token}/", true},
		{"/share/not-even-a-token", "/share/{token}", true},
		{"/share/", "/share/", false},
		{"/share", "/share", false},
		{"/api/v1/public/notes/", "/api/v1/public/notes/", false},
		{"/api/v1/notes/abc", "/api/v1/notes/abc", false},
		{"/notes/abc", "/notes/abc", false},
		{"/sharepoint/" + tok, "/sharepoint/" + tok, false},
	} {
		t.Run(tt.path, func(t *testing.T) {
			got, ok := redactTokenPath(tt.path)
			assert.Equal(t, tt.want, got)
			assert.Equal(t, tt.redacted, ok)
		})
	}
}

// TestPublicLinkTokenNotLoggedOrTraced sends public link requests through the
// full router and checks that the raw token reaches neither a log entry nor
// any span name or attribute, while routing still sees the real token.
func TestPublicLinkTokenNotLoggedOrTraced(t *testing.T) {
	t.Parallel()

	cfg := newTestConfig(t)
	cfg.PublicLinksEnabled = true
	// The real index.html, so /share/{token} runs the preview lookup too.
	require.NoError(t, os.WriteFile(cfg.StaticDir+"/index.html", readWebappIndex(t), 0o600))
	log, hook := newCapturingLogger()
	recorder := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	s, err := newServer(cfg, log, tp)
	require.NoError(t, err)
	t.Cleanup(func() {
		s.StopBackgroundTasks()
		_ = s.GetDB().Close()
	})

	ctx := t.Context()
	_, err = s.GetDB().ExecContext(ctx, `INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`,
		"user00000000000redact", "redact", "x")
	require.NoError(t, err)
	note, err := s.noteStore.Create(ctx, "user00000000000redact", models.NewNote{Type: models.NoteTypeText, Content: "hi", Color: models.DefaultNoteColor})
	require.NoError(t, err)
	link, err := s.noteStore.SetPublicLink(ctx, note.ID, "user00000000000redact", nil)
	require.NoError(t, err)
	token := link.Token
	imageID, err := models.GenerateID()
	require.NoError(t, err)

	for _, tt := range []struct {
		path   string
		status int
		// wantInBody is checked with Contains; "" matches any body.
		wantInBody string
	}{
		{"/api/v1/public/notes/" + token, http.StatusOK, ""},
		{"/api/v1/public/notes/" + token + "?utm=x", http.StatusOK, ""},
		{"/api/v1/public/notes/" + token + "/images/" + imageID, http.StatusNotFound, ""},
		{"/api/v1/public/notes/" + token + "/images/" + imageID + "/thumbnail", http.StatusNotFound, ""},
		// The share page runs the preview card lookup too.
		{"/share/" + token, http.StatusOK, "<title>Shared note</title>"},
	} {
		rec := httptest.NewRecorder()
		s.GetRouter().ServeHTTP(rec, httptest.NewRequestWithContext(ctx, http.MethodGet, tt.path, nil))
		require.Equal(t, tt.status, rec.Code, "%s: %s", tt.path, rec.Body.String())
		assert.Contains(t, rec.Body.String(), tt.wantInBody, tt.path)
	}

	entries := hook.AllEntries()
	require.NotEmpty(t, entries)
	loggedPaths := 0
	for _, e := range entries {
		assert.NotContains(t, e.Message, token)
		for k, v := range e.Data {
			assert.NotContains(t, fmt.Sprint(v), token, "log field %q", k)
		}
		if p, ok := e.Data["path"].(string); ok && strings.Contains(p, redactedToken) {
			loggedPaths++
		}
	}
	assert.Positive(t, loggedPaths, "request log lines carry the redacted path")

	spans := recorder.Ended()
	require.NotEmpty(t, spans)
	tracedPaths := 0
	for _, span := range spans {
		assert.NotContains(t, span.Name(), token)
		for _, attr := range span.Attributes() {
			assert.NotContains(t, attr.Value.String(), token, "span %q attribute %q", span.Name(), attr.Key)
			if attr.Key == "url.path" && strings.Contains(attr.Value.AsString(), redactedToken) {
				tracedPaths++
			}
		}
		for _, ev := range span.Events() {
			for _, attr := range ev.Attributes {
				assert.NotContains(t, attr.Value.String(), token, "span %q event attribute %q", span.Name(), attr.Key)
			}
		}
	}
	assert.Equal(t, 5, tracedPaths, "every request's span records the redacted path")
}
