package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
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

func TestRateLimiterLimitWithWindow(t *testing.T) {
	t.Run("allows requests under the limit", func(t *testing.T) {
		rl := newTestRateLimiter(t)
		mw := rl.limitWithWindow("test", 2, time.Minute, httprate.Key("k"))

		assert.Equal(t, http.StatusOK, doRequest(t.Context(), mw).Code)
		assert.Equal(t, http.StatusOK, doRequest(t.Context(), mw).Code)
	})

	t.Run("rejects requests over the limit with 429 and Retry-After", func(t *testing.T) {
		rl := newTestRateLimiter(t)
		mw := rl.limitWithWindow("test", 2, time.Minute, httprate.Key("k"))

		doRequest(t.Context(), mw)
		doRequest(t.Context(), mw)
		rec := doRequest(t.Context(), mw)

		assert.Equal(t, http.StatusTooManyRequests, rec.Code)
		assert.NotEmpty(t, rec.Header().Get("Retry-After"))
	})

	t.Run("recovers once the window elapses", func(t *testing.T) {
		rl := newTestRateLimiter(t)
		window := 150 * time.Millisecond
		mw := rl.limitWithWindow("test", 1, window, httprate.Key("k"))

		doRequest(t.Context(), mw)
		assert.Equal(t, http.StatusTooManyRequests, doRequest(t.Context(), mw).Code)

		time.Sleep(2 * window)
		assert.Equal(t, http.StatusOK, doRequest(t.Context(), mw).Code)
	})

	t.Run("keys are independent", func(t *testing.T) {
		rl := newTestRateLimiter(t)
		calls := 0
		mw := rl.limitWithWindow("test", 1, time.Minute, func(r *http.Request) (string, error) {
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
		mw := rl.limitWithWindow("test", 1, time.Minute, httprate.Key("k"))

		doRequest(t.Context(), mw)
		assert.Equal(t, http.StatusOK, doRequest(t.Context(), mw).Code)
	})
}

func TestSearchOnly(t *testing.T) {
	limited := searchOnly(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusTooManyRequests)
		})
	})

	handler := limited(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	t.Run("plain listing bypasses the wrapped middleware", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/notes", nil))
		assert.Equal(t, http.StatusOK, rec.Code)
	})

	t.Run("a search query routes through the wrapped middleware", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/notes?search=foo", nil))
		assert.Equal(t, http.StatusTooManyRequests, rec.Code)
	})
}
