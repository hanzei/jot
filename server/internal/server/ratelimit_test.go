package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/synctest"
	"time"

	"github.com/go-chi/httprate"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestRateLimiter(t *testing.T) *rateLimiter {
	t.Helper()
	rl, err := newRateLimiter(&config.Config{RateLimitEnabled: true})
	require.NoError(t, err)
	return rl
}

// doRequest runs a single request through mw and returns the recorded response.
func doRequest(ctx context.Context, mw func(http.Handler) http.Handler) *httptest.ResponseRecorder {
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequestWithContext(ctx, http.MethodGet, "/", nil))
	return rec
}

func TestRateLimiterLimit(t *testing.T) {
	t.Run("allows requests under the limit", func(t *testing.T) {
		rl := newTestRateLimiter(t)
		mw := rl.limit("test", 2, httprate.Key("k"))

		assert.Equal(t, http.StatusOK, doRequest(t.Context(), mw).Code)
		assert.Equal(t, http.StatusOK, doRequest(t.Context(), mw).Code)
	})

	t.Run("rejects requests over the limit with 429 and Retry-After", func(t *testing.T) {
		rl := newTestRateLimiter(t)
		mw := rl.limit("test", 2, httprate.Key("k"))

		doRequest(t.Context(), mw)
		doRequest(t.Context(), mw)
		rec := doRequest(t.Context(), mw)

		assert.Equal(t, http.StatusTooManyRequests, rec.Code)
		assert.NotEmpty(t, rec.Header().Get("Retry-After"))
	})

	t.Run("recovers once the window elapses", func(t *testing.T) {
		// The bubble's fake clock lets this wait out the real one-minute
		// window instantly, with no wall-clock timing to flake under load.
		synctest.Test(t, func(t *testing.T) {
			rl := newTestRateLimiter(t)
			mw := rl.limit("test", 1, httprate.Key("k"))

			doRequest(t.Context(), mw)
			assert.Equal(t, http.StatusTooManyRequests, doRequest(t.Context(), mw).Code)

			time.Sleep(2 * time.Minute)
			assert.Equal(t, http.StatusOK, doRequest(t.Context(), mw).Code)
		})
	})

	t.Run("keys are independent", func(t *testing.T) {
		rl := newTestRateLimiter(t)
		calls := 0
		mw := rl.limit("test", 1, func(r *http.Request) (string, error) {
			calls++
			// Alternate keys so neither ever exceeds its own bucket.
			if calls%2 == 1 {
				return "a", nil
			}
			return "b", nil
		})

		assert.Equal(t, http.StatusOK, doRequest(t.Context(), mw).Code)
		assert.Equal(t, http.StatusOK, doRequest(t.Context(), mw).Code)
	})

	t.Run("disabled rate limiting is a passthrough regardless of the limit", func(t *testing.T) {
		rl, err := newRateLimiter(&config.Config{RateLimitEnabled: false})
		require.NoError(t, err)
		mw := rl.limit("test", 1, httprate.Key("k"))

		doRequest(t.Context(), mw)
		assert.Equal(t, http.StatusOK, doRequest(t.Context(), mw).Code)
	})
}

func TestOnlyWhenQueryParamSet(t *testing.T) {
	limited := onlyWhenQueryParamSet("search", func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusTooManyRequests)
		})
	})

	handler := limited(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	t.Run("request without the query param bypasses the wrapped middleware", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/notes", nil))
		assert.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("a different query param bypasses the wrapped middleware", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/notes?other=foo", nil))
		assert.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("the matching query param routes through the wrapped middleware", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/notes?search=foo", nil))
		assert.Equal(t, http.StatusTooManyRequests, rec.Code)
	})
}

func TestRateLimiterLimitIsMemoizedByBucket(t *testing.T) {
	rl := newTestRateLimiter(t)

	first := rl.limit("shared", 1, httprate.Key("k"))
	second := rl.limit("shared", 1, httprate.Key("k"))

	assert.Equal(t, http.StatusOK, doRequest(t.Context(), first).Code)
	// Same bucket name from a second call site must draw from the same
	// counter, not a fresh independent one.
	assert.Equal(t, http.StatusTooManyRequests, doRequest(t.Context(), second).Code)
}

func TestRateLimiterAllowUser(t *testing.T) {
	t.Run("draws from the same counters as limit for the same key", func(t *testing.T) {
		rl := newTestRateLimiter(t)
		mw := rl.limit("shared", 2, httprate.Key("u1"))
		allow := rl.allowUser("shared", 2)

		assert.Equal(t, http.StatusOK, doRequest(t.Context(), mw).Code)
		assert.True(t, allow(t.Context(), "u1"))
		assert.False(t, allow(t.Context(), "u1"))
		assert.Equal(t, http.StatusTooManyRequests, doRequest(t.Context(), mw).Code)
	})

	t.Run("keys are independent", func(t *testing.T) {
		rl := newTestRateLimiter(t)
		allow := rl.allowUser("test", 1)

		assert.True(t, allow(t.Context(), "u1"))
		assert.False(t, allow(t.Context(), "u1"))
		assert.True(t, allow(t.Context(), "u2"))
	})

	t.Run("always allows when rate limiting is disabled", func(t *testing.T) {
		rl, err := newRateLimiter(&config.Config{RateLimitEnabled: false})
		require.NoError(t, err)
		allow := rl.allowUser("test", 1)

		assert.True(t, allow(t.Context(), "u1"))
		assert.True(t, allow(t.Context(), "u1"))
	})
}
