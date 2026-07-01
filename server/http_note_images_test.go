package main

import (
	"bytes"
	"image"
	"image/color"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// testPNG returns a small valid PNG of the given size.
func testPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 100, A: 255})
		}
	}
	return encodePNG(t, img)
}

func TestUploadNoteImage(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "imgowner", "password123", false)

	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note with images"})
	require.NoError(t, err)

	img, err := user.Client.UploadNoteImage(t.Context(), note.ID, "cat.png", bytes.NewReader(testPNG(t, 10, 20)))
	require.NoError(t, err)
	assert.NotEmpty(t, img.ID)
	assert.Equal(t, "cat.png", img.Filename)
	assert.Equal(t, "image/png", img.ContentType)
	assert.Equal(t, 10, img.Width)
	assert.Equal(t, 20, img.Height)

	fetchedNote, err := user.Client.GetNote(t.Context(), note.ID)
	require.NoError(t, err)
	require.Len(t, fetchedNote.Images, 1)
	assert.Equal(t, img.ID, fetchedNote.Images[0].ID)
}

func TestUploadNoteImageUnauthenticatedReturns401(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "imgauth", "password123", false)

	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note"})
	require.NoError(t, err)

	c := ts.newClient()
	_, err = c.UploadNoteImage(t.Context(), note.ID, "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
	assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
}

func TestUploadNoteImageUnknownNoteReturns404(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "imgnoteid", "password123", false)

	_, err := user.Client.UploadNoteImage(t.Context(), "doesnotexist0000000000", "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
	assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
}

func TestUploadNoteImageNonImageReturns400(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "imgnonimage", "password123", false)

	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note"})
	require.NoError(t, err)

	_, err = user.Client.UploadNoteImage(t.Context(), note.ID, "notanimage.txt", bytes.NewReader([]byte("just some plain text, not an image")))
	assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
}

func TestUploadNoteImageCorruptImageReturns400(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "imgcorrupt", "password123", false)

	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note"})
	require.NoError(t, err)

	// Valid PNG signature bytes but truncated/corrupt body: passes
	// http.DetectContentType but must fail the full decode.
	pngSignature := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00}
	_, err = user.Client.UploadNoteImage(t.Context(), note.ID, "broken.png", bytes.NewReader(pngSignature))
	assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
}

func TestUploadNoteImageOversizeReturns413(t *testing.T) {
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) {
		cfg.UploadMaxBytes = 200
	})
	user := ts.createTestUser(t, "imgoversize", "password123", false)

	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note"})
	require.NoError(t, err)

	// The MaxBytesReader limit includes a fixed multipart-overhead allowance on
	// top of UploadMaxBytes (mirroring UploadProfileIcon), so the payload must
	// clear both to actually trip the 413 path; content doesn't need to be a
	// valid image since the size check runs before any content-type sniffing.
	oversized := bytes.Repeat([]byte{0xFF}, 300_000)
	_, err = user.Client.UploadNoteImage(t.Context(), note.ID, "big.png", bytes.NewReader(oversized))
	assert.Equal(t, http.StatusRequestEntityTooLarge, client.StatusCode(err))
}

func TestUploadNoteImageMaxPerNoteEnforced(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "imgmaxcount", "password123", false)

	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note"})
	require.NoError(t, err)

	for i := range 10 {
		// Vary pixel content per upload so each image hashes to a distinct
		// blob; a dedup hit must not affect the per-note count cap.
		img := image.NewRGBA(image.Rect(0, 0, 4, 4))
		img.Set(0, 0, color.RGBA{R: uint8(i), G: 0, B: 0, A: 255})
		_, uploadErr := user.Client.UploadNoteImage(t.Context(), note.ID, "img.png", bytes.NewReader(encodePNG(t, img)))
		require.NoError(t, uploadErr)
	}

	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	img.Set(0, 0, color.RGBA{R: 255, G: 255, B: 255, A: 255})
	_, err = user.Client.UploadNoteImage(t.Context(), note.ID, "eleventh.png", bytes.NewReader(encodePNG(t, img)))
	assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
}

func TestGetNoteImage(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "imgget", "password123", false)

	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note"})
	require.NoError(t, err)

	data := testPNG(t, 5, 5)
	img, err := user.Client.UploadNoteImage(t.Context(), note.ID, "cat.png", bytes.NewReader(data))
	require.NoError(t, err)

	t.Run("returns bytes with correct content type and nosniff header", func(t *testing.T) {
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.HTTPServer.URL+"/api/v1/images/"+img.ID, nil)
		require.NoError(t, err)

		resp, err := user.Client.HTTPClient().Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()

		assert.Equal(t, http.StatusOK, resp.StatusCode)
		assert.Equal(t, "image/png", resp.Header.Get("Content-Type"))
		assert.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))
		assert.NotEmpty(t, resp.Header.Get("ETag"))
	})

	t.Run("unauthenticated returns 401", func(t *testing.T) {
		c := ts.newClient()
		_, _, err := c.GetNoteImage(t.Context(), img.ID)
		assert.Equal(t, http.StatusUnauthorized, client.StatusCode(err))
	})

	t.Run("unknown image ID returns 404", func(t *testing.T) {
		_, _, err := user.Client.GetNoteImage(t.Context(), "doesnotexist0000000000")
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})
}

func TestNoteImageAccessControl(t *testing.T) {
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "imgaclowner", "password123", false)
	sharedUser := ts.createTestUser(t, "imgaclshared", "password123", false)
	stranger := ts.createTestUser(t, "imgaclstranger", "password123", false)

	note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "shared note"})
	require.NoError(t, err)
	require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, sharedUser.User.ID))

	img, err := owner.Client.UploadNoteImage(t.Context(), note.ID, "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
	require.NoError(t, err)

	t.Run("shared user can download", func(t *testing.T) {
		data, contentType, err := sharedUser.Client.GetNoteImage(t.Context(), img.ID)
		require.NoError(t, err)
		assert.NotEmpty(t, data)
		assert.Equal(t, "image/png", contentType)
	})

	t.Run("non-shared user cannot download", func(t *testing.T) {
		_, _, err := stranger.Client.GetNoteImage(t.Context(), img.ID)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})

	t.Run("non-shared user cannot upload to the note", func(t *testing.T) {
		_, err := stranger.Client.UploadNoteImage(t.Context(), note.ID, "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})

	t.Run("non-shared user cannot delete", func(t *testing.T) {
		err := stranger.Client.DeleteNoteImage(t.Context(), img.ID)
		assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
	})

	t.Run("shared user can delete", func(t *testing.T) {
		require.NoError(t, sharedUser.Client.DeleteNoteImage(t.Context(), img.ID))
	})
}

func TestDeleteNoteImage(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "imgdelete", "password123", false)

	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note"})
	require.NoError(t, err)

	img, err := user.Client.UploadNoteImage(t.Context(), note.ID, "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
	require.NoError(t, err)

	require.NoError(t, user.Client.DeleteNoteImage(t.Context(), img.ID))

	fetchedNote, err := user.Client.GetNote(t.Context(), note.ID)
	require.NoError(t, err)
	assert.Empty(t, fetchedNote.Images)

	_, _, err = user.Client.GetNoteImage(t.Context(), img.ID)
	assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
}

func TestDeleteNoteImageUnknownReturns404(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "imgdeleteunknown", "password123", false)

	err := user.Client.DeleteNoteImage(t.Context(), "doesnotexist0000000000")
	assert.Equal(t, http.StatusNotFound, client.StatusCode(err))
}

// TestNoteImageDedupBlobSurvivesUntilUnreferenced exercises the dedup +
// refcount reclamation path end-to-end over HTTP: the same image bytes
// attached to two different notes hash to one blob, and deleting one
// reference must not affect the other's ability to download its image.
func TestNoteImageDedupBlobSurvivesUntilUnreferenced(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "imgdedup", "password123", false)

	noteA, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note A"})
	require.NoError(t, err)
	noteB, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note B"})
	require.NoError(t, err)

	data := testPNG(t, 6, 6)
	imgA, err := user.Client.UploadNoteImage(t.Context(), noteA.ID, "shared.png", bytes.NewReader(data))
	require.NoError(t, err)
	imgB, err := user.Client.UploadNoteImage(t.Context(), noteB.ID, "shared.png", bytes.NewReader(data))
	require.NoError(t, err)

	require.NoError(t, user.Client.DeleteNoteImage(t.Context(), imgA.ID))

	// The blob backing imgB must still be reachable: it was deduped with
	// imgA's now-deleted row, and the delete must only reclaim it once the
	// last referencing row is gone.
	downloaded, _, err := user.Client.GetNoteImage(t.Context(), imgB.ID)
	require.NoError(t, err)
	assert.Equal(t, data, downloaded)

	require.NoError(t, user.Client.DeleteNoteImage(t.Context(), imgB.ID))
}

// imageSHA256 looks up an image's content hash directly from the DB, since
// it is intentionally not exposed on the API response.
func imageSHA256(t *testing.T, ts *TestServer, imageID string) string {
	t.Helper()
	var sha string
	require.NoError(t, ts.Server.GetDB().QueryRow("SELECT sha256 FROM note_images WHERE id = ?", imageID).Scan(&sha))
	return sha
}

// blobExists reports whether a blob is present on disk under the test
// server's configured upload directory, mirroring FSBlobstore's layout.
func blobExists(t *testing.T, ts *TestServer, sha string) bool {
	t.Helper()
	path := filepath.Join(ts.Config.UploadDir, "blobs", sha[0:2], sha[2:4], sha)
	_, err := os.Stat(path)
	if err == nil {
		return true
	}
	require.True(t, os.IsNotExist(err), "unexpected stat error: %v", err)
	return false
}

func TestPermanentNoteDeleteReclaimsImageBlob(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "imgpurgeowner", "password123", false)

	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note"})
	require.NoError(t, err)
	img, err := user.Client.UploadNoteImage(t.Context(), note.ID, "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
	require.NoError(t, err)
	sha := imageSHA256(t, ts, img.ID)
	require.True(t, blobExists(t, ts, sha), "blob should exist right after upload")

	require.NoError(t, user.Client.DeleteNote(t.Context(), note.ID))
	require.NoError(t, user.Client.DeleteNotePermanently(t.Context(), note.ID))

	assert.False(t, blobExists(t, ts, sha), "permanently deleting the note's last reference must reclaim its image blob")
}

func TestPermanentNoteDeleteKeepsSharedBlobUntilLastReferenceGone(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "imgpurgededup", "password123", false)

	noteA, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note A"})
	require.NoError(t, err)
	noteB, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note B"})
	require.NoError(t, err)

	data := testPNG(t, 4, 4)
	imgA, err := user.Client.UploadNoteImage(t.Context(), noteA.ID, "shared.png", bytes.NewReader(data))
	require.NoError(t, err)
	_, err = user.Client.UploadNoteImage(t.Context(), noteB.ID, "shared.png", bytes.NewReader(data))
	require.NoError(t, err)
	sha := imageSHA256(t, ts, imgA.ID)

	require.NoError(t, user.Client.DeleteNote(t.Context(), noteA.ID))
	require.NoError(t, user.Client.DeleteNotePermanently(t.Context(), noteA.ID))

	assert.True(t, blobExists(t, ts, sha), "noteB still references this hash; the blob must survive noteA's permanent delete")
}

func TestEmptyTrashReclaimsImageBlobs(t *testing.T) {
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "imgemptytrash", "password123", false)

	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "note"})
	require.NoError(t, err)
	img, err := user.Client.UploadNoteImage(t.Context(), note.ID, "cat.png", bytes.NewReader(testPNG(t, 4, 4)))
	require.NoError(t, err)
	sha := imageSHA256(t, ts, img.ID)

	require.NoError(t, user.Client.DeleteNote(t.Context(), note.ID))
	_, err = user.Client.EmptyTrash(t.Context())
	require.NoError(t, err)

	assert.False(t, blobExists(t, ts, sha), "emptying trash must reclaim the deleted note's image blob")
}
