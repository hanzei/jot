package server

import (
	"net/http"
	"net/netip"

	"github.com/go-chi/chi/v5/middleware"
)

// clientIP returns the middlewares that store each request's client IP for
// middleware.GetClientIP, which keys the per-IP rate limits and the request
// log.
//
// The TCP peer is always stored first, so no client-supplied header is
// believed by default. With trusted proxies, chi's ClientIPFromXFF runs on top:
// when the peer is one of them, it walks X-Forwarded-For right to left past
// trusted hops and overwrites the peer with the first untrusted address. A
// client that reaches the server directly is keyed by its own address and
// cannot spoof one.
//
// ClientIPFromXFF only stores an address when it found one, so when the header
// yields no client — a trusted peer sent none (a proxy's own health check),
// every hop in it is trusted, or it is malformed — the peer stored first
// stands, and such requests never share one empty-string key. TestClientIP
// pins that behavior.
func clientIP(trustedProxies []netip.Prefix) []func(http.Handler) http.Handler {
	if len(trustedProxies) == 0 {
		return []func(http.Handler) http.Handler{middleware.ClientIPFromRemoteAddr}
	}
	cidrs := make([]string, len(trustedProxies))
	for i, p := range trustedProxies {
		cidrs[i] = p.String()
	}
	return []func(http.Handler) http.Handler{middleware.ClientIPFromRemoteAddr, middleware.ClientIPFromXFF(cidrs...)}
}
