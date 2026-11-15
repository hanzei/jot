package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A subscriber that stops reading must not be left on an open stream that is
// silently missing events: once its buffer overflows, the server ends the
// stream so the client reconnects and resyncs.
func TestSSESlowSubscriberStreamEnds(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	admin := ts.createTestUser(t, "sseoverflowadmin", "password123", true)
	user := ts.createTestUser(t, "sseoverflowuser", "password123", false)

	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "seed"})
	require.NoError(t, err)

	// A raw stream whose body is not read until the end of the test. The
	// SDK's SubscribeSSE drains the socket continuously, so it would never
	// fall behind. The stream goes over real loopback TCP: the suite's
	// in-memory network buffers without bound, so a writer never blocks on
	// it and the hub's channel would never fill.
	loopback := httptest.NewServer(ts.Server.GetRouter())
	t.Cleanup(loopback.Close)
	streamUser := client.New(loopback.URL).WithHTTPClient(loopback.Client())
	_, err = streamUser.Login(t.Context(), "sseoverflowuser", "password123")
	require.NoError(t, err)

	sseCtx, sseCancel := context.WithTimeout(t.Context(), 2*time.Minute)
	t.Cleanup(sseCancel)
	req, err := http.NewRequestWithContext(sseCtx, http.MethodGet, loopback.URL+"/api/v1/events", nil)
	require.NoError(t, err)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := streamUser.HTTPClient().Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	require.Equal(t, http.StatusOK, resp.StatusCode)

	subscribers := func() int64 {
		stats, err := admin.Client.AdminGetStats(t.Context())
		require.NoError(t, err)
		return stats.Runtime.SSESubscribers
	}
	require.Equal(t, int64(1), subscribers())

	// Each update publishes a note_updated carrying the full note. Large
	// content fills whatever the transport buffers quickly; once ServeSSE is
	// blocked writing, the hub's channel overflows and the subscriber is
	// evicted. The bound only keeps a regression from looping forever.
	content := strings.Repeat("x", models.NoteContentMaxLength-8)
	evicted := false
	for i := 0; i < 5000 && !evicted; i++ {
		c := content + string(rune('a'+i%26))
		_, err := user.Client.UpdateTextNote(t.Context(), note.ID, &client.UpdateTextNoteRequest{Content: &c})
		require.NoError(t, err)
		evicted = subscribers() == 0
	}
	require.True(t, evicted, "slow subscriber should have been evicted")

	// Draining the stream now reaches EOF: the server ended the response
	// rather than keeping a stream that has lost events.
	_, err = io.Copy(io.Discard, resp.Body)
	require.NoError(t, err, "stream should end cleanly, not by the test's timeout")
	assert.NoError(t, sseCtx.Err())
}
