package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"

	"github.com/hanzei/jot/server/internal/server"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// lockedBuffer is a bytes.Buffer safe for the server's background goroutines
// to write to while the test reads it.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return bytes.Clone(b.buf.Bytes())
}

// logLinesForUnauthenticatedRequest starts a server whose logger is set up by
// configureLogging with level and JSON format, sends one unauthenticated
// request, and returns every log line decoded as JSON.
func logLinesForUnauthenticatedRequest(t *testing.T, level string) []map[string]any {
	t.Helper()

	tmpDir := t.TempDir()
	require.NoError(t, os.WriteFile(tmpDir+"/index.html", []byte("<html></html>"), 0o600))
	cfg := defaultTestConfig(t, tmpDir)
	cfg.LogLevel = level
	cfg.LogFormat = "json"

	out := &lockedBuffer{}
	log := logrus.New()
	log.SetOutput(out)
	configureLogging(log, cfg)

	s, err := server.NewWithLogger(cfg, log)
	require.NoError(t, err)
	httpServer := httptest.NewTestServer(t, s.GetRouter())
	t.Cleanup(func() {
		httpServer.Close()
		s.StopBackgroundTasks()
		_ = s.GetDB().Close()
	})

	httpClient := httpServer.Client() // sets httpServer.URL
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, httpServer.URL+"/api/v1/notes", nil)
	require.NoError(t, err)
	resp, err := httpClient.Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)

	var lines []map[string]any
	scanner := bufio.NewScanner(bytes.NewReader(out.Bytes()))
	for scanner.Scan() {
		var line map[string]any
		require.NoError(t, json.Unmarshal(scanner.Bytes(), &line), "not one JSON object per line: %s", scanner.Text())
		lines = append(lines, line)
	}
	require.NoError(t, scanner.Err())
	return lines
}

func findLogLine(lines []map[string]any, msg string) map[string]any {
	for _, line := range lines {
		if line["msg"] == msg {
			return line
		}
	}
	return nil
}

func TestConfigureLogging(t *testing.T) {
	t.Parallel()

	const rejected = "Auth rejected: no session cookie or bearer token"

	t.Run("debug level emits debug lines as JSON with request_id", func(t *testing.T) {
		t.Parallel()
		lines := logLinesForUnauthenticatedRequest(t, "debug")
		line := findLogLine(lines, rejected)
		require.NotNil(t, line, "missing debug line in %v", lines)
		assert.Equal(t, "debug", line["level"])
		assert.NotEmpty(t, line["request_id"])
	})

	t.Run("info level hides debug lines", func(t *testing.T) {
		t.Parallel()
		lines := logLinesForUnauthenticatedRequest(t, "info")
		assert.Nil(t, findLogLine(lines, rejected))
		assert.NotNil(t, findLogLine(lines, "Request completed"))
	})
}
