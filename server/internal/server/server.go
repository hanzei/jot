package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
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
)

//nolint:gochecknoglobals
var (
	version = "dev"
	commit  = "unknown"
)

type Server struct {
	router         chi.Router
	db             *database.DB
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
		allowedOrigin = "http://localhost:3000"
	}
	s.router.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{allowedOrigin},
		AllowedMethods:   []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodOptions},
		AllowedHeaders:   []string{"Accept", "Content-Type"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	s.router.Get("/health", s.handleHealth)

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
		})
	})

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

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write([]byte("OK")); err != nil {
		logrus.WithError(err).Error("Failed to write health check response")
	}
}

type aboutResponse struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
}

func (s *Server) handleAbout(w http.ResponseWriter, _ *http.Request) (int, error) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(aboutResponse{Version: version, Commit: commit}); err != nil {
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
	server := &http.Server{
		Addr:         addr,
		Handler:      s.router,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
	return server.ListenAndServe()
}
