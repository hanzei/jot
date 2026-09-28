package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// errorEnvelope mirrors apierr.ErrorResponse, decoded independently so the
// test pins the wire format rather than the Go type.
type errorEnvelope struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// rawRequest issues a request with httpClient and returns the status, the
// headers, and the body. Tests of the error format use it instead of
// [client.Client] because they assert on the raw wire format.
func rawRequest(t *testing.T, httpClient *http.Client, method, url string, body io.Reader, header http.Header) (int, http.Header, []byte) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, url, body)
	require.NoError(t, err)
	for k, v := range header {
		req.Header[k] = v
	}
	resp, err := httpClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return resp.StatusCode, resp.Header, respBody
}

// requireEnvelope asserts the response is the JSON error envelope with the
// given status and code, and returns its message.
func requireEnvelope(t *testing.T, wantStatus int, wantCode string, status int, header http.Header, body []byte) string {
	t.Helper()
	require.Equal(t, wantStatus, status, "body: %s", body)
	assert.Equal(t, "application/json", header.Get("Content-Type"))
	var env errorEnvelope
	require.NoError(t, json.Unmarshal(body, &env), "body is not JSON: %s", body)
	assert.Equal(t, wantCode, env.Error.Code)
	assert.NotEmpty(t, env.Error.Message)
	return env.Error.Message
}

var jsonHeader = http.Header{"Content-Type": {"application/json"}}

func TestErrorEnvelope(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "envowner", "password123", false)
	// The first registered user becomes admin, so other is the non-admin.
	other := ts.createTestUser(t, "envother", "password123", false)
	api := ts.HTTPServer.URL + "/api/v1"

	note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "hello"})
	require.NoError(t, err)

	t.Run("404 from a store sentinel", func(t *testing.T) {
		missingID, err := models.GenerateID()
		require.NoError(t, err)
		status, header, body := rawRequest(t, owner.Client.HTTPClient(), http.MethodGet, api+"/notes/"+missingID, nil, nil)
		msg := requireEnvelope(t, http.StatusNotFound, "not_found", status, header, body)
		assert.Equal(t, models.ErrNoteNotFound.Error(), msg)
	})

	t.Run("400 validation", func(t *testing.T) {
		status, header, body := rawRequest(t, owner.Client.HTTPClient(), http.MethodPost, api+"/notes", strings.NewReader("{not json"), jsonHeader)
		requireEnvelope(t, http.StatusBadRequest, "validation_failed", status, header, body)
	})

	t.Run("401 from auth middleware", func(t *testing.T) {
		status, header, body := rawRequest(t, ts.httpClient, http.MethodGet, api+"/me", nil, nil)
		requireEnvelope(t, http.StatusUnauthorized, "unauthorized", status, header, body)
	})

	t.Run("401 invalid credentials", func(t *testing.T) {
		payload := `{"username":"envowner","password":"wrong-password"}`
		status, header, body := rawRequest(t, ts.httpClient, http.MethodPost, api+"/login", strings.NewReader(payload), jsonHeader)
		requireEnvelope(t, http.StatusUnauthorized, "invalid_credentials", status, header, body)
	})

	t.Run("403 admin required", func(t *testing.T) {
		status, header, body := rawRequest(t, other.Client.HTTPClient(), http.MethodGet, api+"/admin/users", nil, nil)
		requireEnvelope(t, http.StatusForbidden, "forbidden", status, header, body)
	})

	t.Run("403 session required for PAT auth", func(t *testing.T) {
		pat := createPAT(t, ts, owner, "envelope")
		header := http.Header{"Authorization": {"Bearer " + pat.Token}}
		status, respHeader, body := rawRequest(t, ts.httpClient, http.MethodGet, api+"/pats", nil, header)
		requireEnvelope(t, http.StatusForbidden, "session_required", status, respHeader, body)
	})

	t.Run("403 cross-origin request", func(t *testing.T) {
		header := http.Header{
			"Content-Type":   {"application/json"},
			"Origin":         {"https://evil.example"},
			"Sec-Fetch-Site": {"cross-site"},
		}
		status, respHeader, body := rawRequest(t, owner.Client.HTTPClient(), http.MethodPost, api+"/notes", strings.NewReader(`{}`), header)
		requireEnvelope(t, http.StatusForbidden, "forbidden", status, respHeader, body)
	})

	t.Run("specific codes", func(t *testing.T) {
		shareWith := func(userID string) (int, http.Header, []byte) {
			payload, err := json.Marshal(map[string]string{"user_id": userID})
			require.NoError(t, err)
			return rawRequest(t, owner.Client.HTTPClient(), http.MethodPost, api+"/notes/"+note.ID+"/share", bytes.NewReader(payload), jsonHeader)
		}

		status, header, body := shareWith(owner.User.ID)
		requireEnvelope(t, http.StatusBadRequest, "cannot_share_with_self", status, header, body)

		require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, other.User.ID))
		status, header, body = shareWith(other.User.ID)
		requireEnvelope(t, http.StatusConflict, "already_shared", status, header, body)

		payload := `{"username":"envowner","password":"password123"}`
		status, header, body = rawRequest(t, ts.httpClient, http.MethodPost, api+"/register", strings.NewReader(payload), jsonHeader)
		requireEnvelope(t, http.StatusConflict, "username_taken", status, header, body)

		_, err := owner.Client.CreateLabel(t.Context(), "work")
		require.NoError(t, err)
		home, err := owner.Client.CreateLabel(t.Context(), "home")
		require.NoError(t, err)
		_, err = owner.Client.RenameLabel(t.Context(), home.ID, "work")
		assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
		assert.Equal(t, "label_name_taken", client.ErrorCode(err))
	})

	t.Run("413 request too large", func(t *testing.T) {
		huge := `{"content":"` + strings.Repeat("a", 2<<20) + `"}`
		status, header, body := rawRequest(t, owner.Client.HTTPClient(), http.MethodPost, api+"/notes", strings.NewReader(huge), jsonHeader)
		requireEnvelope(t, http.StatusRequestEntityTooLarge, "request_too_large", status, header, body)
	})

	t.Run("unknown API routes", func(t *testing.T) {
		for _, path := range []string{"/api/v1/no-such-route", "/api/no-such-route", "/api"} {
			for _, method := range []string{http.MethodGet, http.MethodPost} {
				status, header, body := rawRequest(t, owner.Client.HTTPClient(), method, ts.HTTPServer.URL+path, nil, nil)
				requireEnvelope(t, http.StatusNotFound, "not_found", status, header, body)
			}
		}
	})

	t.Run("405 method not allowed", func(t *testing.T) {
		status, header, body := rawRequest(t, owner.Client.HTTPClient(), http.MethodDelete, api+"/config", nil, nil)
		requireEnvelope(t, http.StatusMethodNotAllowed, "method_not_allowed", status, header, body)
	})

	t.Run("non-API paths keep the SPA's responses", func(t *testing.T) {
		status, header, _ := rawRequest(t, ts.httpClient, http.MethodGet, ts.HTTPServer.URL+"/some/client/route", nil, nil)
		assert.Equal(t, http.StatusOK, status)
		assert.Contains(t, header.Get("Content-Type"), "text/html")

		status, header, _ = rawRequest(t, ts.httpClient, http.MethodPost, ts.HTTPServer.URL+"/some/client/route", nil, nil)
		assert.Equal(t, http.StatusMethodNotAllowed, status)
		assert.NotEqual(t, "application/json", header.Get("Content-Type"))
	})
}

func TestClientDecodesErrorEnvelope(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	u := ts.createTestUser(t, "clientenvelope", "password123", false)

	missingID, err := models.GenerateID()
	require.NoError(t, err)
	_, err = u.Client.GetNote(t.Context(), missingID)
	require.Error(t, err)

	var apiErr *client.Error
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusNotFound, apiErr.StatusCode)
	assert.Equal(t, "not_found", apiErr.Code)
	assert.Equal(t, models.ErrNoteNotFound.Error(), apiErr.Message)
}
