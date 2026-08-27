package server

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	httppprof "net/http/pprof"
	"runtime/pprof"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// newDebugMux builds the handler for the debug listener.
func newDebugMux(metricsEnabled, pprofEnabled bool) *http.ServeMux {
	mux := http.NewServeMux()
	if metricsEnabled {
		mux.Handle("GET /metrics", promhttp.Handler())
	}
	if pprofEnabled {
		registerPprof(mux)
	}
	return mux
}

// registerPprof mounts net/http/pprof's handlers on mux. Importing that package
// also registers them on http.DefaultServeMux via its init(), which Jot never
// serves, so these are the only reachable ones.
//
// Index covers the named profiles below it (heap, goroutine, allocs, block,
// mutex, threadcreate); the four below have paths of their own.
func registerPprof(mux *http.ServeMux) {
	mux.HandleFunc("GET /debug/pprof/", httppprof.Index)
	mux.HandleFunc("GET /debug/pprof/cmdline", httppprof.Cmdline)
	mux.HandleFunc("GET /debug/pprof/profile", httppprof.Profile)
	mux.HandleFunc("GET /debug/pprof/trace", httppprof.Trace)
	// `go tool pprof` POSTs its address list to /symbol. Registering it
	// method-less instead panics ServeMux: more methods than
	// "GET /debug/pprof/" on a more specific path.
	mux.HandleFunc("GET /debug/pprof/symbol", httppprof.Symbol)
	mux.HandleFunc("POST /debug/pprof/symbol", httppprof.Symbol)
}

// startDebugServer starts the auxiliary listener carrying /metrics and
// /debug/pprof. They are here rather than on the API router because this port
// defaults to loopback (JOT_METRICS_HOST): an unauthenticated profiling
// endpoint on the public port would be a free load lever.
func (s *Server) startDebugServer() error {
	debugAddr := fmt.Sprintf("%s:%d", s.cfg.MetricsHost, s.cfg.MetricsPort)
	debugListener, err := (&net.ListenConfig{}).Listen(s.ctx, "tcp", debugAddr)
	if err != nil {
		return fmt.Errorf("listen on debug port %s (JOT_METRICS_HOST/JOT_METRICS_PORT): %w", debugAddr, err)
	}

	// A CPU profile or execution trace writes nothing until its
	// caller-chosen duration (30s by default) elapses, so the WriteTimeout
	// that suits /metrics would truncate every profile taken.
	writeTimeout := 10 * time.Second
	if s.cfg.PprofEnabled {
		writeTimeout = 0
	}

	debugServer := &http.Server{
		Handler:      newDebugMux(s.cfg.MetricsEnabled, s.cfg.PprofEnabled),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: writeTimeout,
		IdleTimeout:  30 * time.Second,
	}
	s.serverMu.Lock()
	s.debugServer = debugServer
	s.serverMu.Unlock()
	s.bgWg.Add(1)
	go func() {
		defer s.bgWg.Done()
		pprof.SetGoroutineLabels(pprof.WithLabels(s.ctx, pprof.Labels("job", "debug-server")))
		if err := debugServer.Serve(debugListener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.log.WithError(err).Error("Debug server stopped unexpectedly")
		}
	}()
	s.log.Infof("Debug server listening on %s (metrics=%t pprof=%t)", debugAddr, s.cfg.MetricsEnabled, s.cfg.PprofEnabled)

	return nil
}

// stopDebugServer shuts the debug listener down if it is running. Errors are
// logged rather than returned: both callers are already on their way out.
func (s *Server) stopDebugServer(ctx context.Context) {
	s.serverMu.RLock()
	debugServer := s.debugServer
	s.serverMu.RUnlock()
	if debugServer == nil {
		return
	}
	if err := debugServer.Shutdown(ctx); err != nil {
		s.log.WithError(err).Warn("Debug server shutdown error")
	}
}
