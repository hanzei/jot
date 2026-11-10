package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/httprate"
	"github.com/hanzei/jot/server/internal/apierr"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/hanzei/jot/server/internal/logutil"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// Bucket names shared between rate-limit construction and route wiring, kept
// as constants so a typo can't silently create an untracked bucket in logs
// and metrics.
const (
	bucketAuth      = "auth"
	bucketBaseline  = "baseline"
	bucketExpensive = "expensive"
	bucketPublic    = "public"
)

// rateLimiter builds the rate-limiting middlewares wired into the router. All
// buckets share a single OTel counter (distinguished by a "bucket" attribute)
// so throttled traffic is observable from one metric regardless of which
// limit rejected it.
//
// Limiters are memoized per bucket name: calling limit or allowUser twice for
// the same bucket (e.g. from two route groups, or from a route and the MCP
// handler) always uses the same underlying limiter/counters, so buckets stay
// shared by name alone rather than by callers having to thread through and
// reuse the same Go variable.
type rateLimiter struct {
	cfg       *config.Config
	throttled metric.Int64Counter

	mu       sync.Mutex
	limiters map[string]*httprate.RateLimiter
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

	return &rateLimiter{cfg: cfg, throttled: throttled, limiters: make(map[string]*httprate.RateLimiter)}, nil
}

// limit returns middleware that responds 429 (with a Retry-After header, set
// by httprate) once a key exceeds requestsPerMinute within a one-minute
// window, or a no-op passthrough when rate limiting is disabled entirely.
// bucket names the logical limit for logs/metrics, independent of which
// route(s) it protects; use one of the bucket* constants.
func (rl *rateLimiter) limit(bucket string, requestsPerMinute int, keyFn httprate.KeyFunc) func(http.Handler) http.Handler {
	if !rl.cfg.RateLimitEnabled {
		return func(next http.Handler) http.Handler { return next }
	}
	l := rl.limiter(bucket, requestsPerMinute)
	onError := rl.onCheckError(bucket)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// The key is passed to httprate as is rather than through its
			// WithKeyFuncs, which appends a separator, so that allowUser's
			// keys land in the same counters.
			key, err := keyFn(r)
			if err != nil {
				onError(w, r, err)
				return
			}
			if l.RespondOnLimit(w, r, key) {
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// allowUser is the non-middleware form of limit for a bucket keyed by user
// ID, for operations that are not routes of their own: one /mcp request can
// carry any tool, so the MCP handler checks a bucket per tool call. The
// returned function draws one request from userID's bucket and reports whether
// it was within the limit, or an error if the check itself failed; either way
// the limiter's handlers have counted and logged it, as for limit. It always
// allows when rate limiting is disabled.
func (rl *rateLimiter) allowUser(bucket string, requestsPerMinute int) func(ctx context.Context, userID string) (bool, error) {
	if !rl.cfg.RateLimitEnabled {
		return func(context.Context, string) (bool, error) { return true, nil }
	}
	l := rl.limiter(bucket, requestsPerMinute)
	return func(ctx context.Context, userID string) (bool, error) {
		// httprate and the limiter's handlers only read the request's context.
		r := (&http.Request{}).WithContext(ctx)
		w := &limitResult{header: http.Header{}}
		if !l.RespondOnLimit(w, r, userID) {
			return true, nil
		}
		if w.status == http.StatusTooManyRequests {
			return false, nil
		}
		return false, errors.New("rate limit check failed")
	}
}

// limiter returns the memoized limiter for bucket, creating it on first use.
// Callers supply the key on every check, so the limiter has no key function.
func (rl *rateLimiter) limiter(bucket string, requestsPerMinute int) *httprate.RateLimiter {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	if l, ok := rl.limiters[bucket]; ok {
		return l
	}

	l := httprate.NewRateLimiter(requestsPerMinute, time.Minute,
		httprate.WithLimitHandler(rl.onLimitExceeded(bucket)),
		httprate.WithErrorHandler(rl.onCheckError(bucket)),
	)
	rl.limiters[bucket] = l
	return l
}

// limitResult is the response writer allowUser hands httprate. The headers
// and body written to it go nowhere; status records which of the limiter's
// handlers responded. As in net/http, the first status written wins: on a
// counter failure httprate calls the error handler (500) and then the limit
// handler (429).
type limitResult struct {
	header http.Header
	status int
}

func (w *limitResult) Header() http.Header         { return w.header }
func (w *limitResult) Write(b []byte) (int, error) { return len(b), nil }

func (w *limitResult) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}

// onLimitExceeded logs and counts a throttled request, then responds 429.
// httprate has already set the Retry-After/X-RateLimit-* headers by the time
// this runs.
func (rl *rateLimiter) onLimitExceeded(bucket string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rl.throttled.Add(r.Context(), 1, metric.WithAttributes(attribute.String("bucket", bucket)))
		logutil.FromContext(r.Context()).WithField("ratelimit_bucket", bucket).Warn("Rate limit exceeded")
		apierr.Write(w, r, http.StatusTooManyRequests, apierr.CodeRateLimited, "too many requests")
	}
}

// onCheckError handles a failed rate-limit check: a KeyFunc failure (e.g.
// keyByUserID running before AuthMiddleware has populated the request
// context, which the route wiring rules out) or a counter failure (which the
// in-memory counter never reports). Left to httprate's default handler, either
// would leak the raw Go error text to the client with a 428 status. Logs
// server-side instead and responds with a generic 500, matching wrapHandler's
// convention of hiding internal error detail.
func (rl *rateLimiter) onCheckError(bucket string) func(http.ResponseWriter, *http.Request, error) {
	return func(w http.ResponseWriter, r *http.Request, err error) {
		logutil.FromContext(r.Context()).WithError(err).WithField("ratelimit_bucket", bucket).Error("Rate limit check failed")
		apierr.Write(w, r, http.StatusInternalServerError, apierr.CodeInternal, apierr.InternalMessage)
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
//
// Caveat: behind a reverse proxy, the direct TCP peer is the proxy itself, so
// every client behind it collapses onto one key and shares a single bucket —
// see the "Rate limiting" section of README.md.
func keyByClientIP(r *http.Request) (string, error) {
	return httprate.CanonicalizeIP(middleware.GetClientIP(r.Context())), nil
}

// onlyWhenQueryParamSet wraps a rate-limit middleware so it only applies to
// requests carrying a non-empty value for the given query parameter, leaving
// every other request to whatever broader limiter already wraps it. Used to
// gate GET /notes's search path (handlers.SearchQueryParam) without limiting
// plain note listing, which shares that route.
func onlyWhenQueryParamSet(param string, mw func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		limited := mw(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get(param) == "" {
				next.ServeHTTP(w, r)
				return
			}
			limited.ServeHTTP(w, r)
		})
	}
}
