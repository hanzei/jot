package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/database"
	"github.com/hanzei/jot/server/internal/handlers"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/hanzei/jot/server/internal/sse"
	"github.com/sirupsen/logrus"
	httpSwagger "github.com/swaggo/http-swagger/v2"
)

func buildInfo() aboutResponse {
	c := commit
	if len(c) > 7 {
		c = c[:7]
	}
	return aboutResponse{
		Version:   strings.TrimPrefix(version, "v"),
		Commit:    c,
		BuildTime: buildTime,
		GoVersion: runtime.Version(),
	}
}

type Server struct {
	router         chi.Router
	db             *database.DB
	httpServer     *http.Server
	startErr       error
	startReady     chan struct{}
	startReadyOnce sync.Once
	shuttingDown   atomic.Bool
	serverMu       sync.RWMutex
	sessionService *auth.SessionService
	authHandler    *handlers.AuthHandler
	notesHandler   *handlers.NotesHandler
	labelsHandler  *handlers.LabelsHandler
	eventsHandler  *handlers.EventsHandler
	adminHandler   *handlers.AdminHandler
}

func New() *Server {
	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "./jot.db"
	}

	db, err := database.New(dbPath)
	if err != nil {
		logrus.Fatalf("Failed to initialize database: %v", err)
	}

	userStore := models.NewUserStore(db.DB)
	noteStore := models.NewNoteStore(db.DB)
	sessionStore := models.NewSessionStore(db.DB)
	userSettingsStore := models.NewUserSettingsStore(db.DB)

	sessionService := auth.NewSessionService(sessionStore, userStore)

	go func() {
		for range time.Tick(time.Hour) {
			if err := sessionStore.DeleteExpired(); err != nil {
				logrus.WithError(err).Error("failed to delete expired sessions")
			}
		}
	}()

	go func() {
		if err := noteStore.PurgeOldTrashedNotes(7 * 24 * time.Hour); err != nil {
			logrus.WithError(err).Error("failed to purge old trashed notes on startup")
		}
		for range time.Tick(time.Hour) {
			if err := noteStore.PurgeOldTrashedNotes(7 * 24 * time.Hour); err != nil {
				logrus.WithError(err).Error("failed to purge old trashed notes")
			}
		}
	}()

	hub := sse.NewHub()

	authHandler := handlers.NewAuthHandler(userStore, sessionService, userSettingsStore)
	notesHandler := handlers.NewNotesHandler(noteStore, userStore, hub)
	labelsHandler := handlers.NewLabelsHandler(noteStore, hub)
	eventsHandler := handlers.NewEventsHandler(hub)
	adminHandler := handlers.NewAdminHandler(userStore)

	s := &Server{
		router:         chi.NewRouter(),
		db:             db,
		startReady:     make(chan struct{}),
		sessionService: sessionService,
		authHandler:    authHandler,
		notesHandler:   notesHandler,
		labelsHandler:  labelsHandler,
		eventsHandler:  eventsHandler,
		adminHandler:   adminHandler,
	}

	s.setupRoutes()
	return s
}

func (s *Server) setupRoutes() {
	s.router.Use(logrusRequestLogger)
	s.router.Use(middleware.Recoverer)
	allowedOrigin := os.Getenv("CORS_ALLOWED_ORIGIN")
	if allowedOrigin == "" {
		allowedOrigin = "http://localhost:5173"
	}
	s.router.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{allowedOrigin},
		AllowedMethods:   []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodOptions},
		AllowedHeaders:   []string{"Accept", "Content-Type"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	s.router.Get("/livez", s.handleLive)
	s.router.Get("/readyz", s.handleReady)

	s.router.Route("/api/v1", func(r chi.Router) {
		r.Post("/register", s.wrapHandler(s.authHandler.Register))
		r.Post("/login", s.wrapHandler(s.authHandler.Login))
		r.Post("/logout", s.wrapHandler(s.authHandler.Logout))

		r.Group(func(r chi.Router) {
			r.Use(s.sessionService.AuthMiddleware)

			r.Get("/events", s.eventsHandler.ServeSSE)

			r.Get("/about", s.wrapHandler(s.handleAbout))
			r.Get("/me", s.wrapHandler(s.authHandler.Me))
			r.Put("/users/me", s.wrapHandler(s.authHandler.UpdateUser))
			r.Put("/users/me/password", s.wrapHandler(s.authHandler.ChangePassword))
			r.Get("/users/me/settings", s.wrapHandler(s.authHandler.GetSettings))
			r.Put("/users/me/settings", s.wrapHandler(s.authHandler.UpdateSettings))
			r.Post("/users/me/profile-icon", s.wrapHandler(s.authHandler.UploadProfileIcon))
			r.Delete("/users/me/profile-icon", s.wrapHandler(s.authHandler.DeleteProfileIcon))
			r.Get("/users/{id}/profile-icon", s.wrapHandler(s.authHandler.GetUserProfileIcon))

			r.Get("/notes", s.wrapHandler(s.notesHandler.GetNotes))
			r.Post("/notes", s.wrapHandler(s.notesHandler.CreateNote))
			r.Post("/notes/reorder", s.wrapHandler(s.notesHandler.ReorderNotes))
			r.Post("/notes/import", s.wrapHandler(s.notesHandler.ImportNotes))
			r.Get("/notes/{id}", s.wrapHandler(s.notesHandler.GetNote))
			r.Put("/notes/{id}", s.wrapHandler(s.notesHandler.UpdateNote))
			r.Delete("/notes/{id}", s.wrapHandler(s.notesHandler.DeleteNote))

			r.Post("/notes/{id}/restore", s.wrapHandler(s.notesHandler.RestoreNote))
			r.Delete("/notes/{id}/permanent", s.wrapHandler(s.notesHandler.PermanentlyDeleteNote))

			r.Post("/notes/{id}/share", s.wrapHandler(s.notesHandler.ShareNote))
			r.Delete("/notes/{id}/share", s.wrapHandler(s.notesHandler.UnshareNote))
			r.Get("/notes/{id}/shares", s.wrapHandler(s.notesHandler.GetNoteShares))

			r.Post("/notes/{id}/labels", s.wrapHandler(s.labelsHandler.AddLabel))
			r.Delete("/notes/{id}/labels/{label_id}", s.wrapHandler(s.labelsHandler.RemoveLabel))

			r.Get("/labels", s.wrapHandler(s.labelsHandler.GetLabels))

			r.Get("/users", s.wrapHandler(s.notesHandler.SearchUsers))
		})

		r.Group(func(r chi.Router) {
			r.Use(s.sessionService.AuthMiddleware)
			r.Use(auth.AdminRequired)

			r.Get("/admin/users", s.wrapHandler(s.adminHandler.GetUsers))
			r.Post("/admin/users", s.wrapHandler(s.adminHandler.CreateUser))
			r.Put("/admin/users/{id}/role", s.wrapHandler(s.adminHandler.UpdateUserRole))
			r.Delete("/admin/users/{id}", s.wrapHandler(s.adminHandler.DeleteUser))
		})
	})

	// Swagger UI at /api/docs/
	s.router.Get("/api/docs/*", httpSwagger.WrapHandler)

	// Serve static files from webapp build directory
	staticDir := os.Getenv("STATIC_DIR")
	if staticDir == "" {
		workDir, err := os.Getwd()
		if err != nil {
			panic(err)
		}
		staticDir = workDir + "/../webapp/build/"
	}
	staticDir = filepath.Clean(staticDir)
	safeStaticDir := strings.NewReplacer("\n", "", "\r", "").Replace(staticDir)

	logrus.Infof("Serving static files from: %s", safeStaticDir) // #nosec G706 -- safeStaticDir has newlines stripped
	filesDir := http.Dir(staticDir)
	FileServer(s.router, "/", filesDir)
}

func FileServer(r chi.Router, path string, root http.FileSystem) {
	if path != "/" && path[len(path)-1] != '/' {
		r.Get(path, http.RedirectHandler(path+"/", http.StatusMovedPermanently).ServeHTTP)
		path += "/"
	}
	path += "*"

	r.Get(path, func(w http.ResponseWriter, req *http.Request) {
		rctx := chi.RouteContext(req.Context())
		pathPrefix := strings.TrimSuffix(rctx.RoutePattern(), "/*")
		fs := http.StripPrefix(pathPrefix, http.FileServer(root))

		// Custom handler for SPA routing
		requestedFile := strings.TrimPrefix(req.URL.Path, pathPrefix)
		if requestedFile == "" {
			requestedFile = "/"
		}
		trimmedPath := strings.TrimSuffix(requestedFile, "/")
		// Probe paths intentionally do not exist under /api/v1, and legacy /health should not resolve to SPA.
		if trimmedPath == "/health" || trimmedPath == "/api/v1/health" || trimmedPath == "/api/v1/livez" || trimmedPath == "/api/v1/readyz" {
			http.NotFound(w, req)
			return
		}

		// Check if file exists
		file, err := root.Open(requestedFile)
		if err != nil {
			// File doesn't exist, serve index.html for SPA routing
			indexFile, err := root.Open("/index.html")
			if err != nil {
				http.NotFound(w, req)
				return
			}
			defer func() {
				if err := indexFile.Close(); err != nil {
					logrus.WithError(err).Error("Failed to close index file")
				}
			}()

			w.Header().Set("Content-Type", "text/html")
			http.ServeContent(w, req, "index.html", time.Time{}, indexFile)
			return
		}
		defer func() {
			if err := file.Close(); err != nil {
				logrus.WithError(err).Error("Failed to close file")
			}
		}()

		// File exists, serve it normally
		fs.ServeHTTP(w, req)
	})
}

func (s *Server) wrapHandler(handler func(w http.ResponseWriter, r *http.Request) (int, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		statusCode, err := handler(w, r)
		if err != nil {
			logrus.WithError(err).WithField("status_code", statusCode).WithField("method", r.Method).WithField("path", r.URL.Path).Error("HTTP handler error")
			msg := err.Error()
			if statusCode >= 500 {
				msg = "internal server error"
			}
			http.Error(w, msg, statusCode)
		}
	}
}

// handleLive serves the liveness probe response.
func (s *Server) handleLive(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write([]byte("OK")); err != nil {
		logrus.WithError(err).Error("Failed to write health check response")
	}
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
		logrus.WithError(err).Warn("Readiness check failed")
		http.Error(w, "NOT READY", http.StatusServiceUnavailable)
		return
	}

	w.WriteHeader(http.StatusOK)
	if _, err := w.Write([]byte("OK")); err != nil {
		logrus.WithError(err).Error("Failed to write readiness response")
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
func (s *Server) handleAbout(w http.ResponseWriter, _ *http.Request) (int, error) {
	resp := buildInfo()

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		return http.StatusInternalServerError, fmt.Errorf("encoding about response: %w", err)
	}
	return 0, nil
}

func (s *Server) GetRouter() chi.Router {
	return s.router
}

func (s *Server) GetDB() *database.DB {
	return s.db
}

func logrusRequestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		logrus.WithFields(logrus.Fields{
			"status":   ww.Status(),
			"bytes":    ww.BytesWritten(),
			"duration": time.Since(start).String(),
			"method":   r.Method,
			"path":     r.URL.Path,
			"remote":   r.RemoteAddr,
		}).Info("request completed")
	})
}

func (s *Server) Start(addr string) error {
	logrus.Infof("Server starting on %s", addr)
	listener, err := net.Listen("tcp", addr)
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
