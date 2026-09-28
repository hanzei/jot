package server

import (
	"fmt"
	"net/http"
	"runtime/debug"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/hanzei/jot/server/internal/apierr"
	"github.com/hanzei/jot/server/internal/logutil"
)

// isAPIPath reports whether path is under /api, where every error response is
// the JSON envelope. Anything else is the SPA and keeps net/http's defaults.
func isAPIPath(path string) bool {
	return path == "/api" || strings.HasPrefix(path, "/api/")
}

// apiNotFound answers an unknown route. Registered as the router's NotFound
// handler, so it also sees non-API paths.
func apiNotFound(w http.ResponseWriter, r *http.Request) {
	if !isAPIPath(r.URL.Path) {
		http.NotFound(w, r)
		return
	}
	apierr.Write(w, r, http.StatusNotFound, apierr.CodeNotFound, "route not found")
}

// routableMethods are the methods probed to build a 405's Allow header.
var routableMethods = []string{
	http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
	http.MethodPatch, http.MethodDelete, http.MethodOptions,
}

// allowedMethods lists the methods the router serves for r's path. chi only
// sets the Allow header in its own default 405 handler, which a custom
// MethodNotAllowed handler replaces, so it is rebuilt here.
func allowedMethods(r *http.Request) string {
	rctx := chi.RouteContext(r.Context())
	if rctx == nil || rctx.Routes == nil {
		return ""
	}
	path := r.URL.RawPath
	if path == "" {
		path = r.URL.Path
	}
	var allowed []string
	for _, method := range routableMethods {
		if rctx.Routes.Match(chi.NewRouteContext(), method, path) {
			allowed = append(allowed, method)
		}
	}
	return strings.Join(allowed, ", ")
}

// apiMethodNotAllowed answers a known route requested with a method it does
// not serve.
func apiMethodNotAllowed(w http.ResponseWriter, r *http.Request) {
	if allow := allowedMethods(r); allow != "" {
		w.Header().Set("Allow", allow)
	}
	if !isAPIPath(r.URL.Path) {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	apierr.Write(w, r, http.StatusMethodNotAllowed, apierr.CodeMethodNotAllowed, "method not allowed")
}

// recoverer turns a handler panic into a 500 (the JSON envelope under /api)
// and logs it with its stack, in place of chi's middleware.Recoverer, whose
// response has no body and whose log bypasses logrus. chi's wrapper tracks
// whether the response has started while keeping Flush, Hijack, and ReadFrom.
func recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		defer recoverPanic(ww, r)
		next.ServeHTTP(ww, r)
	})
}

// recoverPanic is recoverer's deferred call; recover() only stops a panic
// when called directly by the deferred function, so it must stay a function
// of its own rather than a helper called from a closure.
func recoverPanic(w middleware.WrapResponseWriter, r *http.Request) {
	rvr := recover()
	if rvr == nil {
		return
	}
	if rvr == http.ErrAbortHandler { //nolint:errorlint // recover() returns the panic value itself, never a wrapped error
		// net/http's sentinel for aborting a response; let it propagate.
		panic(rvr)
	}
	logutil.FromContext(r.Context()).
		WithField("panic", fmt.Sprint(rvr)).
		WithField("stack", string(debug.Stack())).
		Error("Panic while serving request")
	if r.Header.Get("Connection") == "Upgrade" {
		return
	}
	if w.Status() != 0 {
		// The status line (and maybe part of the body, e.g. an SSE stream or
		// an image) is already out, so a 500 can no longer be sent. Abort the
		// connection instead, so the client sees a failure rather than a
		// truncated 200 with an error body appended.
		panic(http.ErrAbortHandler)
	}
	if isAPIPath(r.URL.Path) {
		apierr.Write(w, r, http.StatusInternalServerError, apierr.CodeInternal, apierr.InternalMessage)
		return
	}
	w.WriteHeader(http.StatusInternalServerError)
}
