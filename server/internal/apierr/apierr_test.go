package apierr

import (
	"encoding/json/v2"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hanzei/jot/server/internal/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCodeFor(t *testing.T) {
	tests := []struct {
		name   string
		status int
		err    error
		want   Code
	}{
		{"status fallback 400", http.StatusBadRequest, errors.New("bad"), CodeValidationFailed},
		{"status fallback 401", http.StatusUnauthorized, nil, CodeUnauthorized},
		{"status fallback 403", http.StatusForbidden, nil, CodeForbidden},
		{"status fallback 404", http.StatusNotFound, models.ErrNoteNotFound, CodeNotFound},
		{"status fallback 405", http.StatusMethodNotAllowed, nil, CodeMethodNotAllowed},
		{"status fallback 409", http.StatusConflict, models.ErrNoteVersionConflict, CodeConflict},
		{"status fallback 413", http.StatusRequestEntityTooLarge, nil, CodeRequestTooLarge},
		{"status fallback 422", http.StatusUnprocessableEntity, nil, CodeLimitExceeded},
		{"status fallback 429", http.StatusTooManyRequests, nil, CodeRateLimited},
		{"status fallback other 4xx", http.StatusTeapot, nil, CodeBadRequest},
		{"sentinel", http.StatusConflict, models.ErrUsernameTaken, CodeUsernameTaken},
		{"wrapped sentinel", http.StatusConflict, fmt.Errorf("share: %w", models.ErrNoteAlreadyShared), CodeAlreadyShared},
		{"explicit code", http.StatusBadRequest, New(CodeCannotShareWithSelf, "self"), CodeCannotShareWithSelf},
		{"explicit code beats sentinel", http.StatusConflict, WithCode(CodeConflict, models.ErrUsernameTaken), CodeConflict},
		{"wrapped explicit code", http.StatusForbidden, fmt.Errorf("login: %w", New(CodeLocalLoginDisabled, "off")), CodeLocalLoginDisabled},
		{"5xx is always internal", http.StatusInternalServerError, New(CodeNotFound, "x"), CodeInternal},
		{"5xx sentinel is internal", http.StatusServiceUnavailable, models.ErrLastAdmin, CodeInternal},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, CodeFor(tt.status, tt.err))
		})
	}
}

func TestWithCodePreservesErrorChain(t *testing.T) {
	err := WithCode(CodeLastAdmin, models.ErrLastAdmin)
	require.ErrorIs(t, err, models.ErrLastAdmin)
	assert.Equal(t, models.ErrLastAdmin.Error(), err.Error())
}

func TestWrite(t *testing.T) {
	decode := func(t *testing.T, rec *httptest.ResponseRecorder) ErrorResponse {
		t.Helper()
		var body ErrorResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		return body
	}

	t.Run("writes the envelope", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/notes/x", nil)

		Write(rec, req, http.StatusNotFound, CodeNotFound, "note not found")

		assert.Equal(t, http.StatusNotFound, rec.Code)
		assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
		assert.JSONEq(t, `{"error":{"code":"not_found","message":"note not found"}}`, rec.Body.String())
	})

	t.Run("masks 5xx messages", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/notes", nil)

		WriteErr(rec, req, http.StatusInternalServerError, errors.New("pq: connection refused at 10.0.0.5"))

		body := decode(t, rec)
		assert.Equal(t, CodeInternal, body.Error.Code)
		assert.Equal(t, InternalMessage, body.Error.Message)
	})

	t.Run("nil error uses the status text", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/notes", nil)

		WriteErr(rec, req, http.StatusForbidden, nil)

		body := decode(t, rec)
		assert.Equal(t, CodeForbidden, body.Error.Code)
		assert.Equal(t, http.StatusText(http.StatusForbidden), body.Error.Message)
	})
}
