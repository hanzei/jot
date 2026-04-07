package handlers

import (
	"context"
	"net/http"
)

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
func ClientIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if id := r.Header.Get("X-Client-Id"); id != "" {
			r = r.WithContext(context.WithValue(r.Context(), clientIDContextKey{}, id))
		}
		next.ServeHTTP(w, r)
	})
}
