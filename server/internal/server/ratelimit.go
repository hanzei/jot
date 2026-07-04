package server

import (
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/httprate"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/hanzei/jot/server/internal/logutil"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// rateLimiter builds the rate-limiting middlewares wired into the router. All
// buckets share a single OTel counter (distinguished by a "bucket" attribute)
// so throttled traffic is observable from one metric regardless of which
// limit rejected it.
type rateLimiter struct {
	cfg       *config.Config
	throttled metric.Int64Counter
}

// newRateLimiter creates a rateLimiter with its OTel instrument initialized
// from the global MeterProvider. Returns an error if the instrument cannot be
// created.
func newRateLimiter(cfg *config.Config) (*rateLimiter, error) {
	meter := otel.GetMeterProvider().Meter("github.com/hanzei/jot/server")

	throttled, err := meter.Int64Counter(
		"ratelimit.throttled",
		metric.WithDescription("Requests rejected with 429 by the rate limiter"),
	)
	if err != nil {
		return nil, fmt.Errorf("create ratelimit.throttled instrument: %w", err)
	}

	return &rateLimiter{cfg: cfg, throttled: throttled}, nil
}

// limit returns middleware that responds 429 (with a Retry-After header, set
// by httprate) once a key exceeds requestsPerMinute within a one-minute
// window, or a no-op passthrough when rate limiting is disabled entirely.
// bucket names the logical limit for logs/metrics, independent of which
// route(s) it protects.
func (rl *rateLimiter) limit(bucket string, requestsPerMinute int, keyFn httprate.KeyFunc) func(http.Handler) http.Handler {
	return rl.limitWithWindow(bucket, requestsPerMinute, time.Minute, keyFn)
}

// limitWithWindow is limit with an explicit window, split out so tests can
// exercise burst/recovery behavior with a short window instead of waiting out
// a real minute.
func (rl *rateLimiter) limitWithWindow(bucket string, requestLimit int, window time.Duration, keyFn httprate.KeyFunc) func(http.Handler) http.Handler {
	if !rl.cfg.RateLimitEnabled {
		return func(next http.Handler) http.Handler { return next }
	}
	return httprate.LimitBy(requestLimit, window, keyFn,
		httprate.WithLimitHandler(rl.onLimitExceeded(bucket)),
	)
}

// onLimitExceeded logs and counts a throttled request, then responds 429.
// httprate has already set the Retry-After/X-RateLimit-* headers by the time
// this runs.
func (rl *rateLimiter) onLimitExceeded(bucket string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rl.throttled.Add(r.Context(), 1, metric.WithAttributes(attribute.String("bucket", bucket)))
		logutil.FromContext(r.Context()).WithField("ratelimit_bucket", bucket).Warn("Rate limit exceeded")
		http.Error(w, "too many requests", http.StatusTooManyRequests)
	}
}

// keyByUserID rate-limits by the authenticated user's ID. Must run after
// SessionService.AuthMiddleware has populated the request context.
func keyByUserID(r *http.Request) (string, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return "", fmt.Errorf("rate limit key: no authenticated user in request context")
	}
	return user.ID, nil
}

// keyByClientIP rate-limits unauthenticated requests by the direct TCP peer
// address (via chi's ClientIPFromRemoteAddr, which must run upstream). Jot has
// no documented reverse-proxy trust configuration, so this deliberately avoids
// keying off spoofable client-supplied headers (X-Forwarded-For etc.).
func keyByClientIP(r *http.Request) (string, error) {
	return httprate.CanonicalizeIP(middleware.GetClientIP(r.Context())), nil
}

// searchOnly wraps a rate-limit middleware so it only applies to requests
// carrying a non-empty "search" query parameter, leaving plain note listing
// governed by the baseline per-user limiter alone. GET /notes serves both.
func searchOnly(mw func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		limited := mw(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("search") == "" {
				next.ServeHTTP(w, r)
				return
			}
			limited.ServeHTTP(w, r)
		})
	}
}
