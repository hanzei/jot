package server

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/hanzei/jot/server/internal/config"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestMaxHeaderValueCount drives the real API listener rather than a
// httptest.Server, because the cap is a field on the http.Server that Start
// builds: the integration harness in the root package wraps GetRouter in a
// server of httptest's own making, so it would report a pass whether or not
// the field is wired.
func TestMaxHeaderValueCount(t *testing.T) {
	t.Parallel()

	// Bind an ephemeral port, read it back, then release it so Start can take
	// it. The window between close and re-bind is a race in principle; a
	// collision surfaces as a "listen" error from Start rather than as a
	// silently wrong assertion.
	probe, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := probe.Addr().String()
	require.NoError(t, probe.Close())

	tmpDir := t.TempDir()
	cfg := &config.Config{
		Port:              0,
		DBDriver:          "sqlite",
		DBDSN:             tmpDir + "/test.db",
		StaticDir:         tmpDir,
		UploadDir:         tmpDir + "/uploads",
		UploadMaxBytes:    25 << 20,
		CookieSecure:      false,
		PasswordMinLength: 10,
	}

	log := logrus.New()
	log.SetOutput(io.Discard)

	s, err := NewWithLogger(cfg, log)
	require.NoError(t, err)

	served := make(chan error, 1)
	go func() { served <- s.Start(addr) }()
	t.Cleanup(func() {
		// Not t.Context(): Go cancels that just before cleanups run, and
		// Shutdown threads its context into both WaitUntilStarted and
		// http.Server.Shutdown. Handing it a canceled one makes Shutdown
		// return early without stopping Serve, and the receive below then
		// blocks until the test binary is killed.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		assert.NoError(t, s.Shutdown(ctx))
		s.StopBackgroundTasks()
		_ = s.GetDB().Close()

		select {
		case <-served:
		case <-time.After(30 * time.Second):
			t.Error("Start did not return after Shutdown")
		}
	})

	require.NoError(t, s.WaitUntilStarted(t.Context()))

	// /livez needs no auth, so a non-431 status proves the request reached a
	// handler rather than being turned away for an unrelated reason.
	client := &http.Client{Timeout: 10 * time.Second}
	statusWithHeaderValues := func(t *testing.T, n int) int {
		t.Helper()
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+addr+"/livez", nil)
		require.NoError(t, err)
		// Separate header lines, not one comma-separated value: the cap counts
		// the former individually and the latter once.
		for i := range n {
			req.Header.Add("X-Jot-Test", fmt.Sprint(i))
		}
		resp, err := client.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		_, err = io.Copy(io.Discard, resp.Body)
		require.NoError(t, err)
		return resp.StatusCode
	}

	// The behavioral subtests below pass on Go's own DefaultMaxHeaderValueCount
	// too, since maxHeaderValueCount deliberately matches it. This is what
	// actually pins the ceiling to Jot's constant, so that a toolchain changing
	// its default cannot move it silently.
	t.Run("the API server sets the cap explicitly rather than inheriting it", func(t *testing.T) {
		s.serverMu.RLock()
		defer s.serverMu.RUnlock()
		require.NotNil(t, s.httpServer)
		assert.Equal(t, maxHeaderValueCount, s.httpServer.MaxHeaderValueCount)
	})

	t.Run("a request within the cap is served normally", func(t *testing.T) {
		assert.Equal(t, http.StatusOK, statusWithHeaderValues(t, maxHeaderValueCount/10))
	})

	t.Run("a request over the cap is rejected before reaching a handler", func(t *testing.T) {
		assert.Equal(t, http.StatusRequestHeaderFieldsTooLarge, statusWithHeaderValues(t, maxHeaderValueCount+1))
	})
}
