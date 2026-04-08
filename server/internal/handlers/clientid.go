package handlers

import (
	"context"
	"net/http"
)

// maxClientIDLen caps the X-Client-Id header length stored in context.
// UUIDs are 36 characters; 256 bytes is a generous ceiling that prevents
// large values from propagating through context and SSE JSON payloads.
const maxClientIDLen = 256

type clientIDContextKey struct{}

// clientIDFromContext returns the X-Client-Id value stored in ctx by
// ClientIDMiddleware, or an empty string if none was set.
func clientIDFromContext(ctx context.Context) string {
	v, _ := ctx.Value(clientIDContextKey{}).(string)
	return v
}

// ClientIDMiddleware reads the X-Client-Id request header and stores it in the
// request context so that SSE publish helpers can stamp it onto outgoing events
// without each handler needing to read the header individually.
// Values longer than maxClientIDLen are silently ignored.
func ClientIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if id := r.Header.Get("X-Client-Id"); id != "" && len(id) <= maxClientIDLen {
			r = r.WithContext(context.WithValue(r.Context(), clientIDContextKey{}, id))
		}
		next.ServeHTTP(w, r)
	})
}
