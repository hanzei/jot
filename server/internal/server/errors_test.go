package server

import (
	"encoding/json/v2"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hanzei/jot/server/internal/apierr"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func decodeEnvelope(t *testing.T, rec *httptest.ResponseRecorder) apierr.ErrorResponse {
	t.Helper()
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	var body apierr.ErrorResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body), "body: %s", rec.Body.String())
	return body
}

func TestWrapHandlerErrors(t *testing.T) {
	s := &Server{}

	t.Run("5xx message is masked", func(t *testing.T) {
		h := s.wrapHandler(func(_ http.ResponseWriter, _ *http.Request) (int, any, error) {
			return http.StatusInternalServerError, nil, errors.New("query notes: disk I/O error at /var/lib/jot")
		})
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/notes", nil))

		assert.Equal(t, http.StatusInternalServerError, rec.Code)
		body := decodeEnvelope(t, rec)
		assert.Equal(t, apierr.CodeInternal, body.Error.Code)
		assert.Equal(t, apierr.InternalMessage, body.Error.Message)
		assert.NotContains(t, rec.Body.String(), "disk")
	})

	t.Run("4xx message and explicit code pass through", func(t *testing.T) {
		h := s.wrapHandler(func(_ http.ResponseWriter, _ *http.Request) (int, any, error) {
			return http.StatusBadRequest, nil, apierr.New(apierr.CodeCannotShareWithSelf, "cannot share with self")
		})
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/v1/notes/x/share", nil))

		assert.Equal(t, http.StatusBadRequest, rec.Code)
		body := decodeEnvelope(t, rec)
		assert.Equal(t, apierr.CodeCannotShareWithSelf, body.Error.Code)
		assert.Equal(t, "cannot share with self", body.Error.Message)
	})

	t.Run("MaxBytesError is promoted to 413", func(t *testing.T) {
		h := s.wrapHandler(func(_ http.ResponseWriter, _ *http.Request) (int, any, error) {
			return http.StatusBadRequest, nil, &http.MaxBytesError{Limit: 1}
		})
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/v1/notes", nil))

		assert.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
		assert.Equal(t, apierr.CodeRequestTooLarge, decodeEnvelope(t, rec).Error.Code)
	})
}

func TestRecoverer(t *testing.T) {
	panicky := recoverer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		panic("boom")
	}))

	t.Run("API path gets the masked envelope", func(t *testing.T) {
		rec := httptest.NewRecorder()
		panicky.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/notes", nil))

		assert.Equal(t, http.StatusInternalServerError, rec.Code)
		body := decodeEnvelope(t, rec)
		assert.Equal(t, apierr.CodeInternal, body.Error.Code)
		assert.Equal(t, apierr.InternalMessage, body.Error.Message)
	})

	t.Run("non-API path gets a bare 500", func(t *testing.T) {
		rec := httptest.NewRecorder()
		panicky.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil))

		assert.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Empty(t, rec.Body.String())
	})

	t.Run("panic after the response started aborts instead of appending an envelope", func(t *testing.T) {
		partial := recoverer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("partial"))
			panic("boom")
		}))
		rec := httptest.NewRecorder()
		assert.PanicsWithValue(t, http.ErrAbortHandler, func() {
			partial.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/images/x", nil))
		})
		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "partial", rec.Body.String())
	})

	t.Run("wrapped writer still supports flushing", func(t *testing.T) {
		var flushable bool
		h := recoverer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, flushable = w.(http.Flusher)
		}))
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/events", nil))
		assert.True(t, flushable)
	})

	t.Run("ErrAbortHandler propagates", func(t *testing.T) {
		aborting := recoverer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
			panic(http.ErrAbortHandler)
		}))
		assert.PanicsWithValue(t, http.ErrAbortHandler, func() {
			aborting.ServeHTTP(httptest.NewRecorder(), httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/notes", nil))
		})
	})
}
