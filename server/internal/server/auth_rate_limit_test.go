package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestIPRateLimiterAllowResetsAfterWindow(t *testing.T) {
	current := time.Now()
	limiter := &ipRateLimiter{
		limit:  2,
		window: time.Minute,
		states: map[string]ipRateLimitState{},
		now: func() time.Time {
			return current
		},
	}

	assert.True(t, limiter.allow("127.0.0.1"))
	assert.True(t, limiter.allow("127.0.0.1"))
	assert.False(t, limiter.allow("127.0.0.1"))

	current = current.Add(time.Minute + time.Second)
	assert.True(t, limiter.allow("127.0.0.1"))
}

func TestIPRateLimiterMiddlewareBlocksAfterLimit(t *testing.T) {
	limiterMiddleware := newIPRateLimiter(1, time.Minute, false)
	handler := limiterMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	firstReq := httptest.NewRequest(http.MethodPost, "/api/v1/login", nil)
	firstReq.RemoteAddr = "10.0.0.1:12345"
	firstResp := httptest.NewRecorder()
	handler.ServeHTTP(firstResp, firstReq)
	assert.Equal(t, http.StatusNoContent, firstResp.Code)

	secondReq := httptest.NewRequest(http.MethodPost, "/api/v1/login", nil)
	secondReq.RemoteAddr = "10.0.0.1:12345"
	secondResp := httptest.NewRecorder()
	handler.ServeHTTP(secondResp, secondReq)
	assert.Equal(t, http.StatusTooManyRequests, secondResp.Code)
}

func TestClientIPFromRequest(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.RemoteAddr = "192.168.1.10:54321"
	assert.Equal(t, "192.168.1.10", clientIPFromRequest(req, false))

	req.Header.Set("X-Forwarded-For", "203.0.113.2, 10.0.0.1")
	assert.Equal(t, "192.168.1.10", clientIPFromRequest(req, false))
	assert.Equal(t, "203.0.113.2", clientIPFromRequest(req, true))
}
