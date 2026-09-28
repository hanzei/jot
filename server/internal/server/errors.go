package server

import (
	"fmt"
	"net/http"
	"runtime/debug"
	"strings"

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

// apiMethodNotAllowed answers a known route requested with a method it does
// not serve.
func apiMethodNotAllowed(w http.ResponseWriter, r *http.Request) {
	if !isAPIPath(r.URL.Path) {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	apierr.Write(w, r, http.StatusMethodNotAllowed, apierr.CodeMethodNotAllowed, "method not allowed")
}

// recoverer turns a handler panic into a 500 (the JSON envelope under /api)
// and logs it with its stack, in place of chi's middleware.Recoverer, whose
// response has no body and whose log bypasses logrus.
func recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer recoverPanic(w, r)
		next.ServeHTTP(w, r)
	})
}

// recoverPanic is recoverer's deferred call; recover() only stops a panic
// when called directly by the deferred function, so it must stay a function
// of its own rather than a helper called from a closure.
func recoverPanic(w http.ResponseWriter, r *http.Request) {
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
	if isAPIPath(r.URL.Path) {
		apierr.Write(w, r, http.StatusInternalServerError, apierr.CodeInternal, apierr.InternalMessage)
		return
	}
	w.WriteHeader(http.StatusInternalServerError)
}
