// Package main is the entry point for the Jot server.
//
//	@title			Jot API
//	@version		1.0
//	@description	Self-hosted note-taking application API. Health probes are available at root paths `/livez` and `/readyz` (outside `/api/v1`).
//
//	@contact.name	Jot Project
//	@contact.url	https://github.com/hanzei/jot
//
//	@license.name	MIT
//
//	@BasePath	/api/v1
//
//	@securityDefinitions.apikey	CookieAuth
//	@in							header
//	@name						jot_session
//
//	@tag.name			auth
//	@tag.description	Registration, login, logout and profile management
//
//	@tag.name			notes
//	@tag.description	Note CRUD, reorder, trash and import
//
//	@tag.name			sharing
//	@tag.description	Share notes with other users
//
//	@tag.name			labels
//	@tag.description	Label management
//
//	@tag.name			users
//	@tag.description	User search
//
//	@tag.name			admin
//	@tag.description	Admin-only user management (requires admin role)
//
//	@tag.name			system
//	@tag.description	Health check and build info
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "github.com/hanzei/jot/server/docs"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/hanzei/jot/server/internal/server"
	"github.com/sirupsen/logrus"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		logrus.WithError(err).Fatal("Failed to load configuration")
	}
	if cfg.CORSAllowedOrigin == "" {
		logrus.Warn("CORS_ALLOWED_ORIGIN is not set; all cross-origin requests will be rejected")
	}

	s, err := server.New(cfg)
	if err != nil {
		logrus.WithError(err).Fatal("Failed to initialize server")
	}
	addr := fmt.Sprintf(":%d", cfg.Port)
	logrus.Infof("Starting Jot server on %s", addr)

	serverErrCh := make(chan error, 1)
	go func() {
		serverErrCh <- s.Start(addr)
	}()

	signalCh := make(chan os.Signal, 1)
	signal.Notify(signalCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signalCh)

	select {
	case err := <-serverErrCh:
		if err != nil {
			logrus.WithError(err).Fatal("Server stopped unexpectedly")
		}
		logrus.Info("Server shutdown complete")
	case sig := <-signalCh:
		logrus.WithField("signal", sig.String()).Info("Shutdown signal received")
		s.BeginShutdown()
		const readinessDrainInterval = 2 * time.Second
		logrus.WithField("drain_interval", readinessDrainInterval.String()).Info("Marked server not ready, waiting before shutdown")
		<-time.After(readinessDrainInterval)
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := s.Shutdown(ctx); err != nil {
			logrus.WithError(err).Fatal("Graceful shutdown failed")
		}
		if err := <-serverErrCh; err != nil {
			logrus.WithError(err).Fatal("Server stopped with error after shutdown")
		}
		logrus.Info("Server shutdown complete")
	}
}
