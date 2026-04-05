package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/hanzei/jot/server/internal/database"
	"github.com/hanzei/jot/server/internal/handlers"
	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/mcphandler"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/sse"
	"github.com/sirupsen/logrus"
	httpSwagger "github.com/swaggo/http-swagger/v2"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/trace"
)

func buildInfo() aboutResponse {
	c := commit[:min(len(commit), 7)]
	return aboutResponse{
		Version:   strings.TrimPrefix(version, "v"),
		Commit:    c,
		BuildTime: buildTime,
		GoVersion: runtime.Version(),
	}
}

type Server struct {
	cfg             *config.Config
	router          chi.Router
	db              *database.DB
	httpServer      *http.Server
	staticRoot      *os.Root
	startErr        error
	startReady      chan struct{}
	startReadyOnce  sync.Once
	shuttingDown    atomic.Bool
	serverMu        sync.RWMutex
	ctx             context.Context
	cancel          context.CancelFunc
	bgWg            sync.WaitGroup
	sessionService  *auth.SessionService
	authHandler     *handlers.AuthHandler
	notesHandler    *handlers.NotesHandler
	labelsHandler   *handlers.LabelsHandler
	eventsHandler   *handlers.EventsHandler
	adminHandler    *handlers.AdminHandler
	sessionsHandler *handlers.SessionsHandler
	noteStore       *models.NoteStore
	labelStore      *models.LabelStore
}

func New(cfg *config.Config) (*Server, error) {
	if cfg == nil {
		return nil, fmt.Errorf("config must not be nil")
	}

	db, err := database.New(cfg.DBPath)
	if err != nil {
		return nil, fmt.Errorf("initialize database: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())

	userStore := models.NewUserStore(db.DB)
	noteStore := models.NewNoteStore(db.DB)
	labelStore := models.NewLabelStore(db.DB)
	adminStatsStore := models.NewAdminStatsStore(db.DB)
	sessionStore, err := models.NewSessionStore(db.DB)
	if err != nil {
		cancel()
		_ = db.Close()
		return nil, fmt.Errorf("initialize session store: %w", err)
	}
	userSettingsStore := models.NewUserSettingsStore(db.DB)

	sessionService := auth.NewSessionService(sessionStore, userStore, cfg.CookieSecure)

	hub, err := sse.NewHub()
	if err != nil {
		cancel()
		_ = db.Close()
		return nil, fmt.Errorf("initialize SSE hub: %w", err)
	}

	authHandler := handlers.NewAuthHandler(userStore, sessionService, userSettingsStore, cfg.RegistrationEnabled, cfg.PasswordMinLength)
	notesHandler, err := handlers.NewNotesHandler(noteStore, userStore, labelStore, hub)
	if err != nil {
		cancel()
		_ = db.Close()
		return nil, fmt.Errorf("initialize notes handler: %w", err)
	}
	labelsHandler := handlers.NewLabelsHandler(noteStore, labelStore, hub)
	eventsHandler := handlers.NewEventsHandler(hub)
	adminHandler := handlers.NewAdminHandler(userStore, noteStore, adminStatsStore, userSettingsStore, cfg.DBPath, cfg.PasswordMinLength)
	sessionsHandler := handlers.NewSessionsHandler(sessionStore)

	s := &Server{
		cfg:             cfg,
		router:          chi.NewRouter(),
		db:              db,
		startReady:      make(chan struct{}),
		ctx:             ctx,
		cancel:          cancel,
		sessionService:  sessionService,
		authHandler:     authHandler,
		notesHandler:    notesHandler,
		labelsHandler:   labelsHandler,
		eventsHandler:   eventsHandler,
		adminHandler:    adminHandler,
		sessionsHandler: sessionsHandler,
		noteStore:       noteStore,
		labelStore:      labelStore,
	}

	startPeriodicTask(&s.bgWg, ctx, time.Hour, false, func() error {
		return sessionStore.DeleteExpired(ctx)
	}, "delete expired sessions")
	startPeriodicTask(&s.bgWg, ctx, time.Hour, true, func() error {
		return noteStore.PurgeOldTrashedNotes(ctx, 7*24*time.Hour)
	}, "purge old trashed notes")

	if err := s.setupRoutes(); err != nil {
		cancel()
		_ = db.Close()
		return nil, fmt.Errorf("setup routes: %w", err)
	}
	return s, nil
}

func (s *Server) setupRoutes() error {
	s.router.Use(middleware.RequestID)
	s.router.Use(otelhttp.NewMiddleware(""))
	// otelhttp sets the span name before chi populates RoutePattern, so a
	// second middleware renames the span after routing is complete.
	s.router.Use(chiRouteSpanNamer)
	s.router.Use(requestLoggerMiddleware)
	s.router.Use(middleware.Recoverer)
	s.router.Use(securityHeaders(s.cfg.CookieSecure))

	corsOpts := cors.Options{
		AllowedMethods:   []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions},
		AllowedHeaders:   []string{"Accept", "Content-Type"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: true,
		MaxAge:           300,
	}
	if s.cfg.CORSAllowedOrigin != "" {
		corsOpts.AllowedOrigins = []string{s.cfg.CORSAllowedOrigin}
	} else {
		corsOpts.AllowOriginFunc = func(_ *http.Request, _ string) bool { return false }
	}
	s.router.Use(cors.Handler(corsOpts))

	s.router.Get("/livez", s.wrapHandler(s.handleLive))
	s.router.Get("/readyz", s.handleReady)

	cop := http.NewCrossOriginProtection()
	if s.cfg.CORSAllowedOrigin != "" {
		if err := cop.AddTrustedOrigin(s.cfg.CORSAllowedOrigin); err != nil {
			return fmt.Errorf("add trusted origin %q: %w", s.cfg.CORSAllowedOrigin, err)
		}
	}
	s.router.Route("/api/v1", func(r chi.Router) {
		r.Use(cop.Handler)
		r.Get("/config", s.wrapHandler(s.handleConfig))
		r.Post("/register", s.wrapHandler(s.authHandler.Register))
		r.Post("/login", s.wrapHandler(s.authHandler.Login))
		r.Post("/logout", s.wrapHandler(s.authHandler.Logout))

		r.Group(func(r chi.Router) {
			r.Use(s.sessionService.AuthMiddleware)

			r.Get("/events", s.eventsHandler.ServeSSE)

			r.Get("/about", s.wrapHandler(s.handleAbout))
			r.Get("/me", s.wrapHandler(s.authHandler.Me))
			r.Patch("/users/me", s.wrapHandler(s.authHandler.UpdateUser))
			r.Put("/users/me/password", s.wrapHandler(s.authHandler.ChangePassword))
			r.Post("/users/me/profile-icon", s.wrapHandler(s.authHandler.UploadProfileIcon))
			r.Delete("/users/me/profile-icon", s.wrapHandler(s.authHandler.DeleteProfileIcon))
			r.Get("/users/{id}/profile-icon", s.wrapHandler(s.authHandler.GetUserProfileIcon))

			r.Get("/notes", s.wrapHandler(s.notesHandler.GetNotes))
			r.Post("/notes", s.wrapHandler(s.notesHandler.CreateNote))
			r.Delete("/notes/trash", s.wrapHandler(s.notesHandler.EmptyTrash))
			r.Post("/notes/reorder", s.wrapHandler(s.notesHandler.ReorderNotes))
			r.Post("/notes/import", s.wrapHandler(s.notesHandler.ImportNotes))
			r.Get("/notes/{id}", s.wrapHandler(s.notesHandler.GetNote))
			r.Patch("/notes/{id}", s.wrapHandler(s.notesHandler.UpdateNote))
			r.Delete("/notes/{id}", s.wrapHandler(s.notesHandler.DeleteNote))
			r.Post("/notes/{id}/duplicate", s.wrapHandler(s.notesHandler.DuplicateNote))

			r.Post("/notes/{id}/restore", s.wrapHandler(s.notesHandler.RestoreNote))

			r.Post("/notes/{id}/share", s.wrapHandler(s.notesHandler.ShareNote))
			r.Delete("/notes/{id}/shares/{user_id}", s.wrapHandler(s.notesHandler.UnshareNote))
			r.Get("/notes/{id}/shares", s.wrapHandler(s.notesHandler.GetNoteShares))

			r.Post("/notes/{id}/labels", s.wrapHandler(s.labelsHandler.AddLabel))
			r.Delete("/notes/{id}/labels/{label_id}", s.wrapHandler(s.labelsHandler.RemoveLabel))

			r.Get("/labels", s.wrapHandler(s.labelsHandler.GetLabels))
			r.Patch("/labels/{id}", s.wrapHandler(s.labelsHandler.RenameLabel))
			r.Delete("/labels/{id}", s.wrapHandler(s.labelsHandler.DeleteLabel))

			r.Get("/users", s.wrapHandler(s.notesHandler.SearchUsers))

			r.Get("/sessions", s.wrapHandler(s.sessionsHandler.ListSessions))
			r.Delete("/sessions/{id}", s.wrapHandler(s.sessionsHandler.RevokeSession))

			r.Handle("/mcp", mcphandler.New(s.noteStore, s.labelStore).NewStreamableHTTPHandler())
		})

		r.Group(func(r chi.Router) {
			r.Use(s.sessionService.AuthMiddleware)
			r.Use(auth.AdminRequired)

			r.Get("/admin/stats", s.wrapHandler(s.adminHandler.GetStats))
			r.Get("/admin/users", s.wrapHandler(s.adminHandler.GetUsers))
			r.Post("/admin/users", s.wrapHandler(s.adminHandler.CreateUser))
			r.Put("/admin/users/{id}/role", s.wrapHandler(s.adminHandler.UpdateUserRole))
			r.Delete("/admin/users/{id}", s.wrapHandler(s.adminHandler.DeleteUser))
		})
	})

	// Swagger UI at /api/docs/
	s.router.Get("/api/docs/*", httpSwagger.WrapHandler)
	s.router.Get("/api", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	s.router.Get("/api/*", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})

	safeStaticDir := strings.NewReplacer("\n", "", "\r", "").Replace(s.cfg.StaticDir)

	logrus.Infof("Serving static files from: %s", safeStaticDir) // #nosec G706 -- safeStaticDir has newlines stripped
	staticRoot, err := os.OpenRoot(s.cfg.StaticDir)
	if err != nil {
		return fmt.Errorf("open static directory %s: %w", safeStaticDir, err)
	}
	s.staticRoot = staticRoot
	FileServer(s.router, "/", staticRoot)
	return nil
}

// FileServer registers a catch-all GET route that serves files from root
// using os.Root for traversal-resistant filesystem access.
func FileServer(r chi.Router, path string, root *os.Root) {
	if path != "/" && path[len(path)-1] != '/' {
		r.Get(path, http.RedirectHandler(path+"/", http.StatusMovedPermanently).ServeHTTP)
		path += "/"
	}
	path += "*"

	fsys := root.FS()
	fileServer := http.FileServerFS(fsys)

	r.Get(path, func(w http.ResponseWriter, req *http.Request) {
		rctx := chi.RouteContext(req.Context())
		pathPrefix := strings.TrimSuffix(rctx.RoutePattern(), "/*")

		requestedFile := strings.TrimPrefix(req.URL.Path, pathPrefix)
		if requestedFile == "" {
			requestedFile = "/"
		}

		// Use os.Root for traversal-resistant file existence check.
		cleanPath := strings.TrimPrefix(requestedFile, "/")
		if cleanPath == "" {
			cleanPath = "index.html"
		}

		file, err := root.Open(cleanPath)
		if err != nil {
			// File doesn't exist, serve index.html for SPA routing
			indexFile, err := root.Open("index.html")
			if err != nil {
				http.NotFound(w, req)
				return
			}
			defer func(ctx context.Context) {
				if err := indexFile.Close(); err != nil {
					logutil.FromContext(ctx).WithError(err).Error("Failed to close index file")
				}
			}(req.Context())

			w.Header().Set("Content-Type", "text/html")
			http.ServeContent(w, req, "index.html", time.Time{}, indexFile)
			return
		}
		defer func(ctx context.Context) {
			if err := file.Close(); err != nil {
				logutil.FromContext(ctx).WithError(err).Error("Failed to close file")
			}
		}(req.Context())

		// File exists, serve it via the traversal-safe FS
		fs := http.StripPrefix(pathPrefix, fileServer)
		fs.ServeHTTP(w, req)
	})
}

func (s *Server) wrapHandler(handler func(w http.ResponseWriter, r *http.Request) (int, any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		statusCode, body, err := handler(w, r)
		if err != nil {
			log := logutil.FromContext(r.Context()).WithError(err).WithField("status_code", statusCode)
			if statusCode >= 500 {
				log.Error("HTTP handler error")
			} else {
				log.Warn("HTTP handler error")
			}
			msg := err.Error()
			if statusCode >= 500 {
				msg = "internal server error"
			}
			http.Error(w, msg, statusCode)
			return
		}
		if body != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(statusCode)
			if err := json.NewEncoder(w).Encode(body); err != nil {
				logutil.FromContext(r.Context()).WithError(err).Error("failed to encode response body")
			}
		} else if statusCode > 0 {
			w.WriteHeader(statusCode)
		}
	}
}

// handleLive serves the liveness probe response.
func (s *Server) handleLive(_ http.ResponseWriter, _ *http.Request) (int, any, error) {
	return http.StatusOK, nil, nil
}

// handleReady serves the readiness probe response.
func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	if s.shuttingDown.Load() {
		http.Error(w, "NOT READY", http.StatusServiceUnavailable)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	if err := s.db.PingContext(ctx); err != nil {
		logutil.FromContext(r.Context()).WithError(err).Warn("Readiness check failed")
		http.Error(w, "NOT READY", http.StatusServiceUnavailable)
		return
	}

	w.WriteHeader(http.StatusOK)
	if _, err := w.Write([]byte("OK")); err != nil {
		logutil.FromContext(r.Context()).WithError(err).Error("Failed to write readiness response")
	}
}

type aboutResponse struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildTime string `json:"build_time,omitempty"`
	GoVersion string `json:"go_version,omitempty"`
}

// handleAbout godoc
//
//	@Summary	Get server version and build info
//	@Tags		system
//	@Security	CookieAuth
//	@Produce	json
//	@Success	200	{object}	aboutResponse
//	@Router		/about [get]
func (s *Server) handleAbout(_ http.ResponseWriter, _ *http.Request) (int, any, error) {
	return http.StatusOK, buildInfo(), nil
}

type configResponse struct {
	RegistrationEnabled bool `json:"registration_enabled"`
	PasswordMinLength   int  `json:"password_min_length"`
}

// handleConfig godoc
//
//	@Summary	Get public server configuration
//	@Tags		system
//	@Produce	json
//	@Success	200	{object}	configResponse
//	@Router		/config [get]
func (s *Server) handleConfig(_ http.ResponseWriter, _ *http.Request) (int, any, error) {
	return http.StatusOK, configResponse{
		RegistrationEnabled: s.cfg.RegistrationEnabled,
		PasswordMinLength:   s.cfg.PasswordMinLength,
	}, nil
}

func (s *Server) GetRouter() chi.Router {
	return s.router
}

func (s *Server) GetDB() *database.DB {
	return s.db
}

func securityHeaders(cookieSecure bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("X-Frame-Options", "DENY")
			h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
			h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
			h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'")
			if cookieSecure {
				h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
			}
			next.ServeHTTP(w, r)
		})
	}
}

// chiRouteSpanNamer renames the active OTel span to "METHOD /route/{pattern}"
// after chi has matched the route. It must be registered after otelhttp so the
// span already exists, and it runs the next handler first so chi has populated
// RouteContext before the rename happens.
func chiRouteSpanNamer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		if rctx := chi.RouteContext(r.Context()); rctx != nil && rctx.RoutePattern() != "" {
			trace.SpanFromContext(r.Context()).SetName(r.Method + " " + rctx.RoutePattern())
		}
	})
}

func requestLoggerMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)

		entry := logrus.WithFields(logrus.Fields{
			"request_id": middleware.GetReqID(r.Context()),
			"method":     r.Method,
			"path":       r.URL.Path,
		})
		rl := logutil.NewRequestLogger(entry)
		next.ServeHTTP(ww, r.WithContext(logutil.NewContext(r.Context(), rl)))

		// After next returns, rl may have been enriched by AuthMiddleware with user_id.
		rl.WithFields(logrus.Fields{
			"status":   ww.Status(),
			"duration": time.Since(start).String(),
		}).Info("request completed")
	})
}

func (s *Server) Start(addr string) error {
	listener, err := (&net.ListenConfig{}).Listen(s.ctx, "tcp", addr)
	if err != nil {
		startErr := fmt.Errorf("listen: %w", err)
		s.setStartResult(startErr)
		return startErr
	}

	httpServer := &http.Server{
		Addr:         addr,
		Handler:      s.router,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	s.serverMu.Lock()
	s.httpServer = httpServer
	s.serverMu.Unlock()
	s.setStartResult(nil)

	err = httpServer.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return fmt.Errorf("serving: %w", err)
}

func (s *Server) Shutdown(ctx context.Context) error {
	if err := s.WaitUntilStarted(ctx); err != nil {
		return fmt.Errorf("wait until started: %w", err)
	}

	s.serverMu.RLock()
	httpServer := s.httpServer
	s.serverMu.RUnlock()

	if httpServer == nil {
		return nil
	}

	if err := httpServer.Shutdown(ctx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}

	s.serverMu.Lock()
	if s.httpServer == httpServer {
		s.httpServer = nil
	}
	s.serverMu.Unlock()

	s.cancel()
	s.bgWg.Wait()

	if s.staticRoot != nil {
		if err := s.staticRoot.Close(); err != nil {
			return fmt.Errorf("close static root: %w", err)
		}
	}

	if err := s.db.Close(); err != nil {
		return fmt.Errorf("close database: %w", err)
	}

	return nil
}

func (s *Server) WaitUntilStarted(ctx context.Context) error {
	select {
	case <-s.startReady:
		s.serverMu.RLock()
		startErr := s.startErr
		s.serverMu.RUnlock()
		return startErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) setStartResult(startErr error) {
	s.serverMu.Lock()
	s.startErr = startErr
	s.serverMu.Unlock()

	s.startReadyOnce.Do(func() {
		close(s.startReady)
	})
}

func (s *Server) BeginShutdown() {
	s.shuttingDown.Store(true)
}

// StopBackgroundTasks cancels the server context and waits for all background
// goroutines to finish. It is intended for use in tests that bypass Start/Shutdown.
func (s *Server) StopBackgroundTasks() {
	s.cancel()
	s.bgWg.Wait()
}

// startPeriodicTask starts a background goroutine tracked by wg that calls fn on every interval.
// If runNow is true, fn is also called once immediately before the first tick.
func startPeriodicTask(wg *sync.WaitGroup, ctx context.Context, interval time.Duration, runNow bool, fn func() error, logMsg string) {
	wg.Add(1)
	go func() {
		defer wg.Done()
		if runNow {
			if err := fn(); err != nil {
				logrus.WithError(err).Errorf("failed to %s", logMsg)
			}
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := fn(); err != nil {
					logrus.WithError(err).Errorf("failed to %s", logMsg)
				}
			case <-ctx.Done():
				return
			}
		}
	}()
}
