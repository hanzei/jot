package server

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type ipRateLimitState struct {
	count      int
	windowEnds time.Time
}

type ipRateLimiter struct {
	limit             int
	window            time.Duration
	trustProxyHeaders bool

	mu     sync.Mutex
	states map[string]ipRateLimitState
	now    func() time.Time
}

func newIPRateLimiter(limit int, window time.Duration, trustProxyHeaders bool) func(http.Handler) http.Handler {
	limiter := &ipRateLimiter{
		limit:             limit,
		window:            window,
		trustProxyHeaders: trustProxyHeaders,
		states:            map[string]ipRateLimitState{},
		now:               time.Now,
	}

	return limiter.middleware
}

func (l *ipRateLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !l.allow(clientIPFromRequest(r, l.trustProxyHeaders)) {
			http.Error(w, "too many requests", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (l *ipRateLimiter) allow(ip string) bool {
	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()
	l.cleanupExpiredLocked(now)

	state, ok := l.states[ip]
	if !ok || now.After(state.windowEnds) {
		l.states[ip] = ipRateLimitState{
			count:      1,
			windowEnds: now.Add(l.window),
		}
		return true
	}

	if state.count >= l.limit {
		return false
	}

	state.count++
	l.states[ip] = state
	return true
}

func (l *ipRateLimiter) cleanupExpiredLocked(now time.Time) {
	for ip, state := range l.states {
		if now.After(state.windowEnds) {
			delete(l.states, ip)
		}
	}
}

func clientIPFromRequest(r *http.Request, trustProxyHeaders bool) string {
	if trustProxyHeaders {
		xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For"))
		if xff != "" {
			parts := strings.Split(xff, ",")
			for i := range parts {
				candidate := strings.TrimSpace(parts[i])
				if candidate != "" && net.ParseIP(candidate) != nil {
					return candidate
				}
			}
		}
	}

	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}

	if r.RemoteAddr != "" {
		return r.RemoteAddr
	}

	return "unknown"
}
