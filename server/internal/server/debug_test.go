package server

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime/pprof"
	"testing"
	"time"

	"github.com/hanzei/jot/server/internal/config"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewDebugMux(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name           string
		metricsEnabled bool
		pprofEnabled   bool
		metricsStatus  int
		pprofStatus    int
	}{
		{name: "both enabled", metricsEnabled: true, pprofEnabled: true, metricsStatus: http.StatusOK, pprofStatus: http.StatusOK},
		{name: "metrics only", metricsEnabled: true, pprofEnabled: false, metricsStatus: http.StatusOK, pprofStatus: http.StatusNotFound},
		{name: "pprof only", metricsEnabled: false, pprofEnabled: true, metricsStatus: http.StatusNotFound, pprofStatus: http.StatusOK},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			srv := httptest.NewServer(newDebugMux(tt.metricsEnabled, tt.pprofEnabled))
			defer srv.Close()

			get := func(path string) int {
				req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, srv.URL+path, nil)
				require.NoError(t, err)
				resp, err := srv.Client().Do(req)
				require.NoError(t, err)
				defer resp.Body.Close()
				_, err = io.Copy(io.Discard, resp.Body)
				require.NoError(t, err)
				return resp.StatusCode
			}

			assert.Equal(t, tt.metricsStatus, get("/metrics"))
			assert.Equal(t, tt.pprofStatus, get("/debug/pprof/"))
			// Served by Index rather than by a route of its own.
			assert.Equal(t, tt.pprofStatus, get("/debug/pprof/goroutine?debug=1"))
			assert.Equal(t, tt.pprofStatus, get("/debug/pprof/cmdline"))
		})
	}
}

// TestStartPeriodicTaskSetsGoroutineLabel asserts the label actually lands on
// the running goroutine, not just that the call compiles.
func TestStartPeriodicTaskSetsGoroutineLabel(t *testing.T) {
	t.Parallel()

	log := logrus.New()
	log.SetOutput(io.Discard)
	s := &Server{log: log}

	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(func() {
		cancel()
		s.bgWg.Wait()
	})

	ran := make(chan struct{})
	s.startPeriodicTask(ctx, "test-job", time.Hour, true, func() error {
		close(ran)
		return nil
	}, "run the test job")

	select {
	case <-ran:
	case <-time.After(5 * time.Second):
		t.Fatal("periodic task did not run")
	}

	var buf bytes.Buffer
	require.NoError(t, pprof.Lookup("goroutine").WriteTo(&buf, 1))
	assert.Contains(t, buf.String(), `"job":"test-job"`)
}

// TestStartReturnsWhenMainListenerFails covers the cleanup path taken when the
// debug server is up but the API listener cannot bind: bgWg also tracks the
// periodic tasks, so without canceling the server context first, Start blocks
// on them forever instead of returning the error.
func TestStartReturnsWhenMainListenerFails(t *testing.T) {
	t.Parallel()

	// Hold the address Start will try to bind, so its Listen fails.
	blocker, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { _ = blocker.Close() })

	log := logrus.New()
	log.SetOutput(io.Discard)

	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	s := &Server{
		// Port 0 for the debug server: it has to start successfully for this
		// path to be reachable, and an ephemeral port cannot collide.
		cfg:        &config.Config{MetricsEnabled: true, MetricsHost: "127.0.0.1", MetricsPort: 0},
		log:        log,
		ctx:        ctx,
		cancel:     cancel,
		startReady: make(chan struct{}),
	}
	s.startPeriodicTask(ctx, "test-job", time.Hour, false, func() error { return nil }, "run the test job")
	t.Cleanup(s.bgWg.Wait)

	done := make(chan error, 1)
	go func() { done <- s.Start(blocker.Addr().String()) }()

	select {
	case err := <-done:
		require.ErrorContains(t, err, "listen")
	case <-time.After(10 * time.Second):
		t.Fatal("Start did not return after the API listener failed")
	}
}
