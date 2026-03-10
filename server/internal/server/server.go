package server

import (
	"log"
	"net/http"
	"path/filepath"
	"os"
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

type Server struct {
	router         chi.Router
	db             *database.DB
	sessionService *auth.SessionService
	authHandler    *handlers.AuthHandler
	notesHandler   *handlers.NotesHandler
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
		log.Fatalf("Failed to initialize database: %v", err)
	}

	userStore := models.NewUserStore(db.DB)
	noteStore := models.NewNoteStore(db.DB)
	sessionStore := models.NewSessionStore(db.DB)

	sessionService := auth.NewSessionService(sessionStore, userStore)

	go func() {
		for range time.Tick(time.Hour) {
			if err := sessionStore.DeleteExpired(); err != nil {
				logrus.WithError(err).Error("failed to delete expired sessions")
			}
		}
	}()

	hub := sse.NewHub()

	authHandler := handlers.NewAuthHandler(userStore, sessionService)
	notesHandler := handlers.NewNotesHandler(noteStore, userStore, hub)
	eventsHandler := handlers.NewEventsHandler(hub)
	adminHandler := handlers.NewAdminHandler(userStore)

	s := &Server{
		router:         chi.NewRouter(),
		db:             db,
		sessionService: sessionService,
		authHandler:    authHandler,
		notesHandler:   notesHandler,
		eventsHandler:  eventsHandler,
		adminHandler:   adminHandler,
	}

	s.setupRoutes()
	return s
}

func (s *Server) setupRoutes() {
	s.router.Use(middleware.Logger)
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

			r.Get("/me", s.wrapHandler(s.authHandler.Me))

			r.Get("/notes", s.wrapHandler(s.notesHandler.GetNotes))
			r.Post("/notes", s.wrapHandler(s.notesHandler.CreateNote))
			r.Post("/notes/reorder", s.wrapHandler(s.notesHandler.ReorderNotes))
			r.Get("/notes/{id}", s.wrapHandler(s.notesHandler.GetNote))
			r.Put("/notes/{id}", s.wrapHandler(s.notesHandler.UpdateNote))
			r.Delete("/notes/{id}", s.wrapHandler(s.notesHandler.DeleteNote))

			r.Post("/notes/{id}/share", s.wrapHandler(s.notesHandler.ShareNote))
			r.Delete("/notes/{id}/share", s.wrapHandler(s.notesHandler.UnshareNote))
			r.Get("/notes/{id}/shares", s.wrapHandler(s.notesHandler.GetNoteShares))

			r.Get("/users", s.wrapHandler(s.notesHandler.SearchUsers))
		})

		r.Group(func(r chi.Router) {
			r.Use(s.sessionService.AuthMiddleware)
			r.Use(auth.AdminRequired)

			r.Get("/admin/users", s.wrapHandler(s.adminHandler.GetUsers))
			r.Post("/admin/users", s.wrapHandler(s.adminHandler.CreateUser))
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

	if _, err := os.Stat(staticDir); os.IsNotExist(err) {
		log.Printf("Static directory not found: %s (frontend files not available)", safeStaticDir) // #nosec G706 -- safeStaticDir has newlines stripped
	} else {
		log.Printf("Serving static files from: %s", safeStaticDir) // #nosec G706 -- safeStaticDir has newlines stripped
		filesDir := http.Dir(staticDir)
		FileServer(s.router, "/", filesDir)
	}
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
					log.Printf("Failed to close index file: %v", err)
				}
			}()

			w.Header().Set("Content-Type", "text/html")
			http.ServeContent(w, req, "index.html", time.Time{}, indexFile)
			return
		}
		defer func() {
			if err := file.Close(); err != nil {
				log.Printf("Failed to close file: %v", err)
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

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write([]byte("OK")); err != nil {
		log.Printf("Failed to write health check response: %v", err)
	}
}

func (s *Server) GetRouter() chi.Router {
	return s.router
}

func (s *Server) GetDB() *database.DB {
	return s.db
}

func (s *Server) Start(addr string) error {
	log.Printf("Server starting on %s", addr)
	server := &http.Server{
		Addr:         addr,
		Handler:      s.router,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 0, // disabled to support long-lived SSE connections
		IdleTimeout:  60 * time.Second,
	}
	return server.ListenAndServe()
}
