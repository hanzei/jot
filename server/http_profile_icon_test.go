package main

import (
	"bytes"
	"image"
	"image/color"
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetProfileIconNoIconReturns404(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "noiconuser", "password123", false)
	_, _, err := user.Client.GetProfileIcon(t.Context(), user.User.ID)
	assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
}

func TestGetProfileIconUnknownUserReturns404(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "iconrequester", "password123", false)
	_, _, err := user.Client.GetProfileIcon(t.Context(), "unknownuser1234567890ab")
	assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
}

func TestGetProfileIconUnauthenticatedReturns401(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "iconauth", "password123", false)

	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := range 8 {
		for x := range 8 {
			img.Set(x, y, color.RGBA{R: 100, G: 150, B: 200, A: 255})
		}
	}
	_, err := user.Client.UploadProfileIcon(t.Context(), "test.png", bytes.NewReader(encodePNG(t, img)))
	require.NoError(t, err)

	c := ts.newClient()
	_, _, err = c.GetProfileIcon(t.Context(), user.User.ID)
	assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
}

func TestGetProfileIconOtherUserCanFetch(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	iconOwner := ts.createTestUser(t, "iconowner", "password123", false)
	otherUser := ts.createTestUser(t, "iconviewer", "password123", false)

	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	_, err := iconOwner.Client.UploadProfileIcon(t.Context(), "owner.png", bytes.NewReader(encodePNG(t, img)))
	require.NoError(t, err)

	_, contentType, err := otherUser.Client.GetProfileIcon(t.Context(), iconOwner.User.ID)
	require.NoError(t, err)
	assert.Equal(t, "image/jpeg", contentType)
}

func TestUploadProfileIconOversizeReturns413(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "iconoversize", "password123", false)

	// profileIconMaxBytes (5 MB) is not configurable, so the payload has to
	// actually clear it plus the multipart-overhead allowance to trip the 413
	// path; content doesn't need to be a valid image since the size check runs
	// before any content-type sniffing.
	oversized := bytes.Repeat([]byte{0xFF}, 6_000_000)
	_, err := user.Client.UploadProfileIcon(t.Context(), "big.png", bytes.NewReader(oversized))
	assert.Equal(t, http.StatusRequestEntityTooLarge, client.StatusCode(err))
}

func TestDeleteProfileIconReturns204(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "deliconuser", "password123", false)

	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	_, err := user.Client.UploadProfileIcon(t.Context(), "test.png", bytes.NewReader(encodePNG(t, img)))
	require.NoError(t, err)

	require.NoError(t, user.Client.DeleteProfileIcon(t.Context()))
}

func TestDeleteProfileIconMakesIconInaccessible(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "deliconuser2", "password123", false)

	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	_, err := user.Client.UploadProfileIcon(t.Context(), "test.png", bytes.NewReader(encodePNG(t, img)))
	require.NoError(t, err)

	require.NoError(t, user.Client.DeleteProfileIcon(t.Context()))

	_, _, err = user.Client.GetProfileIcon(t.Context(), user.User.ID)
	assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
}

func TestDeleteProfileIconIdempotent(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "nodeliconuser", "password123", false)
	require.NoError(t, user.Client.DeleteProfileIcon(t.Context()))
}

func TestDeleteProfileIconUnauthenticatedReturns401(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	c := ts.newClient()
	err := c.DeleteProfileIcon(t.Context())
	assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
}
