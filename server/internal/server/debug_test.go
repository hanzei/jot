package server

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime/pprof"
	"strconv"
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

// TestStartCleansUpAfterFailure covers the failed-start path for each way Start
// can fail. bgWg tracks the periodic tasks NewWithLogger already started, and
// Shutdown will not clean them up afterwards — it returns the start error out of
// WaitUntilStarted first — so Start has to cancel and drain them itself.
func TestStartCleansUpAfterFailure(t *testing.T) {
	t.Parallel()

	// occupied holds an address for the test's lifetime, so binding it fails.
	occupied := func(t *testing.T) (addr string, port int) {
		t.Helper()
		l, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
		require.NoError(t, err)
		t.Cleanup(func() { _ = l.Close() })
		_, portStr, err := net.SplitHostPort(l.Addr().String())
		require.NoError(t, err)
		port, err = strconv.Atoi(portStr)
		require.NoError(t, err)
		return l.Addr().String(), port
	}

	tests := []struct {
		name string
		// setup returns the config to start with and the API address to bind.
		setup func(t *testing.T) (*config.Config, string)
	}{
		{
			name: "api listener fails with the debug server up",
			setup: func(t *testing.T) (*config.Config, string) {
				apiAddr, _ := occupied(t)
				// Port 0 for the debug server: it has to start successfully for
				// this case, and an ephemeral port cannot collide.
				return &config.Config{MetricsEnabled: true, MetricsHost: "127.0.0.1", MetricsPort: 0}, apiAddr
			},
		},
		{
			name: "api listener fails with no debug server",
			setup: func(t *testing.T) (*config.Config, string) {
				apiAddr, _ := occupied(t)
				return &config.Config{}, apiAddr
			},
		},
		{
			name: "debug listener fails",
			setup: func(t *testing.T) (*config.Config, string) {
				_, debugPort := occupied(t)
				// The API address is never reached: Start gives up on the debug
				// listener before binding it.
				return &config.Config{MetricsEnabled: true, MetricsHost: "127.0.0.1", MetricsPort: debugPort}, "127.0.0.1:0"
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			cfg, apiAddr := tt.setup(t)

			log := logrus.New()
			log.SetOutput(io.Discard)

			ctx, cancel := context.WithCancel(t.Context())
			t.Cleanup(cancel)
			s := &Server{
				cfg:        cfg,
				log:        log,
				ctx:        ctx,
				cancel:     cancel,
				startReady: make(chan struct{}),
			}
			s.startPeriodicTask(ctx, "test-job", time.Hour, false, func() error { return nil }, "run the test job")

			done := make(chan error, 1)
			go func() { done <- s.Start(apiAddr) }()

			select {
			case err := <-done:
				require.ErrorContains(t, err, "listen")
			case <-time.After(10 * time.Second):
				t.Fatal("Start did not return after the listener failed")
			}

			drained := make(chan struct{})
			go func() {
				s.bgWg.Wait()
				close(drained)
			}()
			select {
			case <-drained:
			case <-time.After(10 * time.Second):
				t.Fatal("background tasks still running after the failed start")
			}
		})
	}
}
