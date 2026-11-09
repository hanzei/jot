package server

import (
	"context"
	"net/http"
	"net/url"
	"strings"
)

// redactedToken replaces a public link token in logged and traced paths.
const redactedToken = "{token}"

// tokenPathPrefixes are the paths whose next segment is a public link token:
// the public API and the webapp's viewer page. A token is a credential, so it
// must never reach request logs or span attributes.
var tokenPathPrefixes = []string{"/api/v1/public/notes/", "/share/"}

// redactTokenPath returns path with the public link token segment replaced by
// redactedToken, and whether path carries a token at all.
func redactTokenPath(path string) (string, bool) {
	for _, prefix := range tokenPathPrefixes {
		rest, ok := strings.CutPrefix(path, prefix)
		if !ok || rest == "" {
			continue
		}
		_, tail, hasTail := strings.Cut(rest, "/")
		if hasTail {
			return prefix + redactedToken + "/" + tail, true
		}
		return prefix + redactedToken, true
	}
	return path, false
}

// logPath is the request path as it may be logged.
func logPath(path string) string {
	redacted, _ := redactTokenPath(path)
	return redacted
}

type originalURLKey struct{}

type originalURL struct {
	url        *url.URL
	requestURI string
}

// redactTokenPaths wraps a middleware that records the request URL (otelhttp,
// which puts url.path on the span) so it only ever sees the redacted path of a
// public link request. The real URL is restored before the request continues
// past the wrapped middleware, so routing and handlers are unaffected.
func redactTokenPaths(mw func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		restore := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if orig, ok := r.Context().Value(originalURLKey{}).(originalURL); ok {
				r = r.WithContext(context.WithValue(r.Context(), originalURLKey{}, nil))
				r.URL = orig.url
				r.RequestURI = orig.requestURI
			}
			next.ServeHTTP(w, r)
		})
		wrapped := mw(restore)

		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			redacted, ok := redactTokenPath(r.URL.Path)
			if !ok {
				wrapped.ServeHTTP(w, r)
				return
			}
			ctx := context.WithValue(r.Context(), originalURLKey{}, originalURL{url: r.URL, requestURI: r.RequestURI})
			hidden := r.WithContext(ctx)
			u := *r.URL
			u.Path = redacted
			u.RawPath = ""
			hidden.URL = &u
			hidden.RequestURI = u.RequestURI()
			wrapped.ServeHTTP(w, hidden)
		})
	}
}
