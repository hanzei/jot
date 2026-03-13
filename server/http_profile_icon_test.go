package main

import (
	"image"
	"image/color"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetProfileIconNoIconReturns404(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "noiconuser", "password123", false)
	resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/users/"+user.User.ID+"/profile-icon", nil)
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestGetProfileIconUnknownUserReturns404(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "iconrequester", "password123", false)
	resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/users/unknownuser1234567890ab/profile-icon", nil)
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestGetProfileIconUnauthenticatedReturns401(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "iconauth", "password123", false)

	// Upload an icon so the user has one.
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := range 8 {
		for x := range 8 {
			img.Set(x, y, color.RGBA{R: 100, G: 150, B: 200, A: 255})
		}
	}
	body, ct := createMultipartImage(t, "file", "test.png", encodePNG(t, img))
	require.Equal(t, http.StatusOK, ts.uploadProfileIcon(t, user, body, ct).StatusCode)

	// Unauthenticated client should be rejected.
	resp := ts.request(t, nil, http.MethodGet, "/api/v1/users/"+user.User.ID+"/profile-icon", nil)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestGetProfileIconOtherUserCanFetch(t *testing.T) {
	ts := setupTestServer(t)
	iconOwner := ts.createTestUser(t, "iconowner", "password123", false)
	otherUser := ts.createTestUser(t, "iconviewer", "password123", false)

	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	body, ct := createMultipartImage(t, "file", "owner.png", encodePNG(t, img))
	require.Equal(t, http.StatusOK, ts.uploadProfileIcon(t, iconOwner, body, ct).StatusCode)

	// Another authenticated user can retrieve it.
	resp := ts.authRequest(t, otherUser, http.MethodGet, "/api/v1/users/"+iconOwner.User.ID+"/profile-icon", nil)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "image/jpeg", resp.Headers.Get("Content-Type"))
}

func TestDeleteProfileIconReturns204(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "deliconuser", "password123", false)

	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	body, ct := createMultipartImage(t, "file", "test.png", encodePNG(t, img))
	require.Equal(t, http.StatusOK, ts.uploadProfileIcon(t, user, body, ct).StatusCode)

	resp := ts.authRequest(t, user, http.MethodDelete, "/api/v1/users/me/profile-icon", nil)
	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
}

func TestDeleteProfileIconMakesIconInaccessible(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "deliconuser2", "password123", false)

	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	body, ct := createMultipartImage(t, "file", "test.png", encodePNG(t, img))
	require.Equal(t, http.StatusOK, ts.uploadProfileIcon(t, user, body, ct).StatusCode)

	ts.authRequest(t, user, http.MethodDelete, "/api/v1/users/me/profile-icon", nil)

	resp := ts.authRequest(t, user, http.MethodGet, "/api/v1/users/"+user.User.ID+"/profile-icon", nil)
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestDeleteProfileIconIdempotent(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "nodeliconuser", "password123", false)

	// Delete when no icon exists — should still succeed.
	resp := ts.authRequest(t, user, http.MethodDelete, "/api/v1/users/me/profile-icon", nil)
	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
}

func TestDeleteProfileIconUnauthenticatedReturns401(t *testing.T) {
	ts := setupTestServer(t)
	resp := ts.request(t, nil, http.MethodDelete, "/api/v1/users/me/profile-icon", nil)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
