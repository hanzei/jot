package sse

import "context"

type clientIDContextKey struct{}

// WithClientID returns a copy of ctx carrying the originating client's ID (the
// X-Client-Id request header), which publishers stamp onto outgoing events so
// the client that made a change can ignore its own echo.
func WithClientID(ctx context.Context, clientID string) context.Context {
	return context.WithValue(ctx, clientIDContextKey{}, clientID)
}

// ClientIDFromContext returns the client ID stored by WithClientID, or an empty
// string if none was set.
func ClientIDFromContext(ctx context.Context) string {
	v, _ := ctx.Value(clientIDContextKey{}).(string)
	return v
}
