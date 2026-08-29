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

// TestMaxHeaderValueCount drives the real API listener: the cap lives on the
// http.Server that Start builds, which the root package's harness cannot observe.
func TestMaxHeaderValueCount(t *testing.T) {
	t.Parallel()

	// Claim an ephemeral port and release it for Start. A collision in that
	// window surfaces as a "listen" error, not a wrong assertion.
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
		// WithoutCancel: Go cancels t.Context() just before cleanups run, and
		// Shutdown passes its context on. A canceled one returns without
		// stopping Serve, hanging the receive below.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(t.Context()), 30*time.Second)
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

	// /livez needs no auth, so a non-431 proves the request reached a handler.
	client := &http.Client{Timeout: 10 * time.Second}
	statusWithHeaderValues := func(t *testing.T, n int) int {
		t.Helper()
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+addr+"/livez", nil)
		require.NoError(t, err)
		// Separate lines: the cap counts these individually, a comma-separated
		// value once.
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

	// maxHeaderValueCount is Go's own default, so only this subtest notices the
	// field being dropped.
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
