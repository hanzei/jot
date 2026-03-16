package main

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"net/http"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetProfileIconNoIconReturns404(t *testing.T) {
	ts := setupTestServer(t)
	ctx := context.Background()
	user := ts.createTestUser(t, "noiconuser", "password123", false)
	_, _, err := user.Client.GetProfileIcon(ctx, user.User.ID)
	assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
}

func TestGetProfileIconUnknownUserReturns404(t *testing.T) {
	ts := setupTestServer(t)
	ctx := context.Background()
	user := ts.createTestUser(t, "iconrequester", "password123", false)
	_, _, err := user.Client.GetProfileIcon(ctx, "unknownuser1234567890ab")
	assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
}

func TestGetProfileIconUnauthenticatedReturns401(t *testing.T) {
	ts := setupTestServer(t)
	ctx := context.Background()
	user := ts.createTestUser(t, "iconauth", "password123", false)

	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := range 8 {
		for x := range 8 {
			img.Set(x, y, color.RGBA{R: 100, G: 150, B: 200, A: 255})
		}
	}
	_, err := user.Client.UploadProfileIcon(ctx, "test.png", bytes.NewReader(encodePNG(t, img)))
	require.NoError(t, err)

	c := ts.newClient()
	_, _, err = c.GetProfileIcon(ctx, user.User.ID)
	assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
}

func TestGetProfileIconOtherUserCanFetch(t *testing.T) {
	ts := setupTestServer(t)
	ctx := context.Background()
	iconOwner := ts.createTestUser(t, "iconowner", "password123", false)
	otherUser := ts.createTestUser(t, "iconviewer", "password123", false)

	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	_, err := iconOwner.Client.UploadProfileIcon(ctx, "owner.png", bytes.NewReader(encodePNG(t, img)))
	require.NoError(t, err)

	_, contentType, err := otherUser.Client.GetProfileIcon(ctx, iconOwner.User.ID)
	require.NoError(t, err)
	assert.Equal(t, "image/jpeg", contentType)
}

func TestDeleteProfileIconReturns204(t *testing.T) {
	ts := setupTestServer(t)
	ctx := context.Background()
	user := ts.createTestUser(t, "deliconuser", "password123", false)

	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	_, err := user.Client.UploadProfileIcon(ctx, "test.png", bytes.NewReader(encodePNG(t, img)))
	require.NoError(t, err)

	require.NoError(t, user.Client.DeleteProfileIcon(ctx))
}

func TestDeleteProfileIconMakesIconInaccessible(t *testing.T) {
	ts := setupTestServer(t)
	ctx := context.Background()
	user := ts.createTestUser(t, "deliconuser2", "password123", false)

	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	_, err := user.Client.UploadProfileIcon(ctx, "test.png", bytes.NewReader(encodePNG(t, img)))
	require.NoError(t, err)

	require.NoError(t, user.Client.DeleteProfileIcon(ctx))

	_, _, err = user.Client.GetProfileIcon(ctx, user.User.ID)
	assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
}

func TestDeleteProfileIconIdempotent(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "nodeliconuser", "password123", false)
	require.NoError(t, user.Client.DeleteProfileIcon(context.Background()))
}

func TestDeleteProfileIconUnauthenticatedReturns401(t *testing.T) {
	ts := setupTestServer(t)
	c := ts.newClient()
	err := c.DeleteProfileIcon(context.Background())
	assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
}
