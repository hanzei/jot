package server

import (
	"net/http"
	"net/netip"

	"github.com/go-chi/chi/v5/middleware"
)

// clientIP returns middleware that stores each request's client IP for
// middleware.GetClientIP, which keys the per-IP rate limits and the request
// log.
//
// With no trusted proxies it is the TCP peer, so no client-supplied header is
// believed. With trusted proxies, X-Forwarded-For is read when the peer is one
// of them, walking the chain right to left past trusted hops (chi's
// ClientIPFromXFF). A client that reaches the server directly is keyed by its
// own address and cannot spoof one.
//
// When the header yields no client — a trusted peer sent none (a proxy's own
// health check), every hop in it is trusted, or it is malformed — the TCP peer
// is used instead, so such requests never share one empty-string key.
func clientIP(trustedProxies []netip.Prefix) func(http.Handler) http.Handler {
	if len(trustedProxies) == 0 {
		return middleware.ClientIPFromRemoteAddr
	}
	cidrs := make([]string, len(trustedProxies))
	for i, p := range trustedProxies {
		cidrs[i] = p.String()
	}
	fromXFF := middleware.ClientIPFromXFF(cidrs...)
	return func(next http.Handler) http.Handler {
		fromPeer := middleware.ClientIPFromRemoteAddr(next)
		return fromXFF(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !middleware.GetClientIPAddr(r.Context()).IsValid() {
				fromPeer.ServeHTTP(w, r)
				return
			}
			next.ServeHTTP(w, r)
		}))
	}
}
