// Package main is the entry point for the Jot server.
//
//	@title						Jot API
//	@version					1.0
//	@description				Self-hosted note-taking application API. Health probes are available at root paths `/livez` and `/readyz` (outside `/api/v1`). Every response carries an `X-Request-Id` header identifying the request in the server's logs and traces; quote it when reporting a failure. A request may send its own `X-Request-Id` (at most 64 characters of `[A-Za-z0-9._-]`) to have it used instead; any other value is replaced.
//
//	@contact.name				Jot Project
//	@contact.url				https://github.com/hanzei/jot
//
//	@license.name				MIT
//
//	@BasePath					/api/v1
//
//	@securityDefinitions.apikey	CookieAuth
//	@in							header
//	@name						jot_session
//
//	@tag.name					auth
//	@tag.description			Registration, login, logout and profile management
//
//	@tag.name					notes
//	@tag.description			Note CRUD, reorder, trash and import
//
//	@tag.name					sharing
//	@tag.description			Share notes with other users
//
//	@tag.name					labels
//	@tag.description			Label management
//
//	@tag.name					users
//	@tag.description			User search
//
//	@tag.name					admin
//	@tag.description			Admin-only user management (requires admin role)
//
//	@tag.name					system
//	@tag.description			Health check and build info
package main

import (
	"context"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	_ "github.com/hanzei/jot/server/docs"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/hanzei/jot/server/internal/server"
	"github.com/hanzei/jot/server/internal/telemetry"
	"github.com/sirupsen/logrus"
	"go.opentelemetry.io/contrib/bridges/otellogrus"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		logrus.WithError(err).Fatal("Failed to load configuration")
	}
	// Before telemetry.Setup, whose OTel error logger copies the standard
	// logger's level and formatter.
	configureLogging(logrus.StandardLogger(), cfg)

	ctx := context.Background()
	otelShutdown, err := telemetry.Setup(ctx, telemetry.Config{
		Endpoint:       cfg.OTelEndpoint,
		ServiceName:    cfg.OTelServiceName,
		ServiceVersion: server.Version(),
		Insecure:       cfg.OTelInsecure,
		TracesEnabled:  cfg.OTelTracesEnabled,
		MetricsEnabled: cfg.OTelMetricsEnabled,
		LogsEnabled:    cfg.OTelLogsEnabled,
		// /metrics needs the meter provider whether or not OTLP export is on.
		PrometheusEnabled: cfg.MetricsEnabled,
	})
	if err != nil {
		logrus.WithError(err).Fatal("Failed to initialize OpenTelemetry")
	}
	defer func() {
		timeoutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if shutdownErr := otelShutdown(timeoutCtx); shutdownErr != nil {
			logrus.WithError(shutdownErr).Warn("OpenTelemetry shutdown error")
		}
	}()

	if cfg.OTelLogsEnabled {
		// Forward all logrus log entries to the OTel LoggerProvider so they
		// are exported via OTLP alongside traces and metrics.
		logrus.AddHook(otellogrus.NewHook("github.com/hanzei/jot/server"))
	}
	if cfg.OTelTracesEnabled || cfg.OTelMetricsEnabled || cfg.OTelLogsEnabled {
		if cfg.OTelEndpoint != "" {
			logrus.Infof("OpenTelemetry enabled (service: %s)", cfg.OTelServiceName)
		} else {
			logrus.Infof("OpenTelemetry enabled (stdout exporter, service: %s)", cfg.OTelServiceName)
		}
	} else if cfg.OTelEndpoint != "" {
		logrus.Warn("OTEL_EXPORTER_OTLP_ENDPOINT is set but no OTel signals are enabled (JOT_OTEL_TRACES_ENABLED / JOT_OTEL_METRICS_ENABLED / JOT_OTEL_LOGS_ENABLED); nothing will be exported")
	}

	s, err := server.New(cfg)
	if err != nil {
		logrus.WithError(err).Fatal("Failed to initialize server")
	}
	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	if cfg.MetricsEnabled || cfg.PprofEnabled {
		logrus.Infof("Starting Jot server on %s (debug listener on %s:%d)", addr, cfg.MetricsHost, cfg.MetricsPort)
	} else {
		logrus.Infof("Starting Jot server on %s", addr)
	}

	serverErrCh := make(chan error, 1)
	go func() {
		serverErrCh <- s.Start(addr)
	}()

	signalCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	select {
	case err := <-serverErrCh:
		if err != nil {
			logrus.WithError(err).Fatal("Server stopped unexpectedly")
		}
		logrus.Info("Server shutdown complete")
	case <-signalCtx.Done():
		gracefulShutdown(ctx, signalCtx, s, serverErrCh)
	}
}

// configureLogging applies JOT_LOG_LEVEL and JOT_LOG_FORMAT to log.
// config.Load has already validated both values.
func configureLogging(log *logrus.Logger, cfg *config.Config) {
	level, err := logrus.ParseLevel(cfg.LogLevel)
	if err != nil {
		log.WithError(err).Fatal("Failed to parse JOT_LOG_LEVEL")
	}
	log.SetLevel(level)
	if cfg.LogFormat == "json" {
		log.SetFormatter(&logrus.JSONFormatter{})
	}
}

func gracefulShutdown(baseCtx, signalCtx context.Context, s *server.Server, serverErrCh <-chan error) {
	if cause := context.Cause(signalCtx); cause != nil {
		logrus.WithField("signal", cause.Error()).Info("Shutdown signal received")
	} else {
		logrus.Info("Shutdown signal received")
	}
	s.BeginShutdown()
	const readinessDrainInterval = 2 * time.Second
	logrus.WithField("drain_interval", readinessDrainInterval.String()).Info("Marked server not ready, waiting before shutdown")
	<-time.After(readinessDrainInterval)
	ctx, cancel := context.WithTimeout(baseCtx, 15*time.Second)
	defer cancel()
	if err := s.Shutdown(ctx); err != nil {
		logrus.WithError(err).Fatal("Graceful shutdown failed")
	}
	if err := <-serverErrCh; err != nil {
		logrus.WithError(err).Fatal("Server stopped with error after shutdown")
	}
	logrus.Info("Server shutdown complete")
}
