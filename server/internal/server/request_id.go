package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"

	"github.com/go-chi/chi/v5/middleware"
)

// requestIDHeader carries the request ID on both the request and the response.
// net/http canonicalizes it, so it goes over the wire as "X-Request-Id".
const requestIDHeader = "X-Request-ID"

// maxRequestIDLen bounds a client-supplied request ID, which ends up in every
// log line of its request.
const maxRequestIDLen = 64

// requestID tags each request with an ID, stores it where
// middleware.GetReqID finds it (the request log reads it from there), and
// returns it in the X-Request-Id response header so a client can quote it in a
// bug report and an operator can find the matching log line and trace.
//
// It replaces chi's middleware.RequestID, whose IDs embed the hostname and
// which accepts any incoming X-Request-Id verbatim. An incoming ID is still
// honored, so a client or proxy can correlate with its own ID, but only when
// it is at most 64 characters of [A-Za-z0-9._-]; anything else is replaced
// with a generated one rather than written into the logs.
func requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get(requestIDHeader)
		if !validRequestID(id) {
			id = newRequestID()
		}
		w.Header().Set(requestIDHeader, id)
		ctx := context.WithValue(r.Context(), middleware.RequestIDKey, id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// newRequestID returns 16 random hex characters: short enough to read out of a
// toast, and enough entropy that two requests in one log never share an ID.
func newRequestID() string {
	var b [8]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read never returns an error.
	return hex.EncodeToString(b[:])
}

func validRequestID(id string) bool {
	if id == "" || len(id) > maxRequestIDLen {
		return false
	}
	for i := range len(id) {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '.', c == '_', c == '-':
		default:
			return false
		}
	}
	return true
}
