package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/client"
	"github.com/hanzei/jot/server/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// bundleEntries returns the entries of a Jot export bundle by name.
func bundleEntries(t *testing.T, data []byte) map[string][]byte {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	require.NoError(t, err)
	entries := make(map[string][]byte, len(zr.File))
	for _, f := range zr.File {
		rc, err := f.Open()
		require.NoError(t, err)
		b, err := io.ReadAll(rc)
		require.NoError(t, err)
		require.NoError(t, rc.Close())
		entries[f.Name] = b
	}
	return entries
}

// textNoteManifest is a version 2 manifest holding one text note with the
// given images JSON array.
func textNoteManifest(content, imagesJSON string) string {
	return `{"format":"jot_export","version":2,"exported_at":"2026-01-01T00:00:00Z","notes":[` +
		`{"content":"` + content + `","note_type":"text","color":"#ffffff","position":0,"labels":[],"images":` + imagesJSON + `}]}`
}

func imageFilenames(images []client.NoteImage) []string {
	names := make([]string, 0, len(images))
	for _, img := range images {
		names = append(names, img.Filename)
	}
	return names
}

func TestExportIncludesImages(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "exportimages", "password123", false)

	first, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "first"})
	require.NoError(t, err)
	second, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "second"})
	require.NoError(t, err)

	shared := testPNG(t, 8, 8)
	_, err = user.Client.UploadNoteImage(t.Context(), first.ID, "a.png", bytes.NewReader(shared))
	require.NoError(t, err)
	_, err = user.Client.UploadNoteImage(t.Context(), first.ID, "b.png", bytes.NewReader(testPNG(t, 9, 9)))
	require.NoError(t, err)
	// The same bytes on another note are stored in the bundle once.
	_, err = user.Client.UploadNoteImage(t.Context(), second.ID, "copy.png", bytes.NewReader(shared))
	require.NoError(t, err)

	export, err := user.Client.ExportNotes(t.Context())
	require.NoError(t, err)

	entries := bundleEntries(t, export.Data)
	assert.Len(t, entries, 3, "notes.json plus two distinct images")

	byContent := map[string]client.JotExportNote{}
	for _, n := range export.Manifest.Notes {
		byContent[n.Content] = n
	}
	firstImages := byContent["first"].Images
	require.Len(t, firstImages, 2)
	assert.Equal(t, "a.png", firstImages[0].Filename)
	assert.Equal(t, "b.png", firstImages[1].Filename)
	assert.Equal(t, "image/png", firstImages[0].ContentType)
	assert.NotZero(t, firstImages[0].CreatedAt)
	assert.True(t, strings.HasPrefix(firstImages[0].File, "images/"))
	assert.True(t, strings.HasSuffix(firstImages[0].File, ".png"))
	assert.Equal(t, shared, entries[firstImages[0].File])

	secondImages := byContent["second"].Images
	require.Len(t, secondImages, 1)
	assert.Equal(t, firstImages[0].File, secondImages[0].File)
	assert.Equal(t, "copy.png", secondImages[0].Filename)
}

func TestExportIncludesCollaboratorImagesOnOwnedNotes(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	owner := ts.createTestUser(t, "exportcollabowner", "password123", false)
	collaborator := ts.createTestUser(t, "exportcollabuser", "password123", false)

	note, err := owner.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "shared"})
	require.NoError(t, err)
	require.NoError(t, owner.Client.ShareNote(t.Context(), note.ID, collaborator.User.ID))
	_, err = collaborator.Client.UploadNoteImage(t.Context(), note.ID, "theirs.png", bytes.NewReader(testPNG(t, 5, 5)))
	require.NoError(t, err)

	export, err := owner.Client.ExportNotes(t.Context())
	require.NoError(t, err)
	require.Len(t, export.Manifest.Notes, 1)
	require.Len(t, export.Manifest.Notes[0].Images, 1)
	assert.Equal(t, "theirs.png", export.Manifest.Notes[0].Images[0].Filename)

	// The collaborator doesn't own the note, so it isn't in their export.
	collabExport, err := collaborator.Client.ExportNotes(t.Context())
	require.NoError(t, err)
	assert.Empty(t, collabExport.Manifest.Notes)
}

func TestImportBundleRoundTripWithImages(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	src := ts.createTestUser(t, "bundlesrc", "password123", false)
	dst := ts.createTestUser(t, "bundledst", "password123", false)

	note, err := src.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "gallery"})
	require.NoError(t, err)
	originals := map[string][]byte{
		"one.png":   testPNG(t, 10, 20),
		"two.png":   testPNG(t, 30, 10),
		"three.png": testPNG(t, 12, 12),
	}
	for _, name := range []string{"one.png", "two.png", "three.png"} {
		_, err = src.Client.UploadNoteImage(t.Context(), note.ID, name, bytes.NewReader(originals[name]))
		require.NoError(t, err)
	}
	list, err := src.Client.CreateListNote(t.Context(), &client.CreateListNoteRequest{
		Title: "list",
		Items: []client.CreateNoteItem{{Text: "item", Position: 0}},
	})
	require.NoError(t, err)
	_, err = src.Client.UploadNoteImage(t.Context(), list.ID, "list.png", bytes.NewReader(testPNG(t, 7, 7)))
	require.NoError(t, err)

	export, err := src.Client.ExportNotes(t.Context())
	require.NoError(t, err)

	result, err := dst.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(export.Data))
	require.NoError(t, err)
	assert.Equal(t, 2, result.Imported)
	assert.Empty(t, result.Errors)

	byContent := map[string]client.Note{}
	byTitle := map[string]client.Note{}
	for _, n := range allNotes(t, dst) {
		byContent[n.Content] = n
		byTitle[n.Title] = n
	}

	gallery, ok := byContent["gallery"]
	require.True(t, ok)
	require.Len(t, gallery.Images, 3)
	assert.Equal(t, []string{"one.png", "two.png", "three.png"}, imageFilenames(gallery.Images), "images keep their order")
	for _, img := range gallery.Images {
		assert.Equal(t, "image/png", img.ContentType)

		data, _, err := dst.Client.GetNoteImage(t.Context(), img.ID)
		require.NoError(t, err)
		assert.Equal(t, originals[img.Filename], data)

		thumb, contentType, err := dst.Client.GetNoteImageThumbnail(t.Context(), img.ID)
		require.NoError(t, err)
		assert.NotEmpty(t, thumb)
		assert.Equal(t, "image/jpeg", contentType)
	}
	assert.Equal(t, 10, gallery.Images[0].Width)
	assert.Equal(t, 20, gallery.Images[0].Height)

	listNote, ok := byTitle["list"]
	require.True(t, ok)
	require.Len(t, listNote.Images, 1)
	assert.Equal(t, "list.png", listNote.Images[0].Filename)
}

func TestImportBundleSkipsBadImages(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "bundlebadimages", "password123", false)

	images := `[
		{"file":"images/good.png","filename":"../../elsewhere/good.png","created_at":"2026-01-01T00:00:00Z"},
		{"file":"images/missing.png","filename":"missing.png"},
		{"file":"images/corrupt.png","filename":"corrupt.png"},
		{"file":"images/text.png","filename":"text.png"},
		{"file":"notes.json","filename":"manifest.png"}
	]`
	bundle := jotBundle(t, textNoteManifest("with images", images), map[string][]byte{
		"images/good.png":    testPNG(t, 4, 4),
		"images/corrupt.png": append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0xff}, 64)...),
		"images/text.png":    []byte("just some text"),
	})

	result, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(bundle))
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)
	require.Len(t, result.Errors, 4)
	assert.Contains(t, result.Errors[0], "images/missing.png")
	assert.Contains(t, result.Errors[0], "not found")
	assert.Contains(t, result.Errors[1], "images/corrupt.png")
	assert.Contains(t, result.Errors[1], "corrupt")
	assert.Contains(t, result.Errors[2], "images/text.png")
	assert.Contains(t, result.Errors[2], "unsupported file type")
	assert.Contains(t, result.Errors[3], "notes.json")

	notes := allNotes(t, user)
	require.Len(t, notes, 1)
	require.Len(t, notes[0].Images, 1)
	assert.Equal(t, "good.png", notes[0].Images[0].Filename, "the filename is reduced to its base name")
}

func TestImportBundleCapsImagesPerNote(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "bundleimagecap", "password123", false)

	refs := make([]string, 0, 11)
	for i := range 11 {
		refs = append(refs, fmt.Sprintf(`{"file":"images/same.png","filename":"img%d.png"}`, i))
	}
	bundle := jotBundle(t, textNoteManifest("many", "["+strings.Join(refs, ",")+"]"), map[string][]byte{
		"images/same.png": testPNG(t, 3, 3),
	})

	result, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(bundle))
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)
	require.Len(t, result.Errors, 1)
	assert.Contains(t, result.Errors[0], "only the first 10")

	notes := allNotes(t, user)
	require.Len(t, notes, 1)
	assert.Len(t, notes[0].Images, 10)
}

func TestImportBundleImageOverUploadLimitSkipped(t *testing.T) {
	t.Parallel()
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) { cfg.UploadMaxBytes = 1 << 20 })
	user := ts.createTestUser(t, "bundlebigimage", "password123", false)

	bundle := jotBundle(t, textNoteManifest("big", `[{"file":"images/big.png","filename":"big.png"}]`), map[string][]byte{
		"images/big.png": bytes.Repeat([]byte{0}, 1<<20+1),
	})

	result, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(bundle))
	require.NoError(t, err)
	assert.Equal(t, 1, result.Imported)
	require.Len(t, result.Errors, 1)
	assert.Contains(t, result.Errors[0], "upload limit")
}

func TestImportBundleFailureReclaimsStoredImages(t *testing.T) {
	t.Parallel()
	var uploadDir string
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) { uploadDir = cfg.UploadDir })
	user := ts.createTestUser(t, "bundlerollback", "password123", false)
	failNoteItemInserts(t, ts)

	manifest := `{"format":"jot_export","version":2,"exported_at":"2026-01-01T00:00:00Z","notes":[
		{"content":"pictured","note_type":"text","color":"#ffffff","position":0,"labels":[],"images":[{"file":"images/a.png","filename":"a.png"}]},
		{"title":"broken","note_type":"list","color":"#ffffff","position":1,"labels":[],"items":[{"text":"boom","position":0}]}
	]}`
	bundle := jotBundle(t, manifest, map[string][]byte{"images/a.png": testPNG(t, 6, 6)})

	_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(bundle))
	assert.Equal(t, http.StatusInternalServerError, client.StatusCode(err))

	assert.Empty(t, allNotes(t, user), "the import is all-or-nothing")
	assert.Equal(t, blobCounts{}, countBlobs(t, uploadDir), "images stored for the failed import are reclaimed")
}

func TestImportBundleRejectsInvalidNoteBeforeStoringImages(t *testing.T) {
	t.Parallel()
	var uploadDir string
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) { uploadDir = cfg.UploadDir })
	user := ts.createTestUser(t, "bundleinvalidnote", "password123", false)

	manifest := `{"format":"jot_export","version":2,"exported_at":"2026-01-01T00:00:00Z","notes":[
		{"content":"pictured","note_type":"text","color":"#ffffff","position":0,"labels":[],"images":[{"file":"images/a.png","filename":"a.png"}]},
		{"content":"bad","note_type":"drawing","color":"#ffffff","position":1,"labels":[]}
	]}`
	bundle := jotBundle(t, manifest, map[string][]byte{"images/a.png": testPNG(t, 6, 6)})

	_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(bundle))
	assert.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	assert.Empty(t, allNotes(t, user))
	assert.Equal(t, blobCounts{}, countBlobs(t, uploadDir))
}

func TestImportRejectsPlainJSONExport(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "plainjsonimport", "password123", false)

	payload := `{"format":"jot_export","version":1,"exported_at":"2026-01-01T00:00:00Z","notes":[]}`
	_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.json", strings.NewReader(payload))
	require.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	assert.Contains(t, err.Error(), "older version of Jot")

	_, err = user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", strings.NewReader("not a zip"))
	require.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	assert.Contains(t, err.Error(), "not a zip file")

	// A zip without notes.json isn't a Jot export either.
	_, err = user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(buildZip(t, map[string][]byte{"other.json": []byte("{}")})))
	require.Equal(t, http.StatusBadRequest, client.StatusCode(err))
	assert.Contains(t, err.Error(), "notes.json is missing")
}

// rawZipEntry is a zip entry written verbatim, with whatever uncompressed
// size it claims, to build archives that lie about their contents.
type rawZipEntry struct {
	name             string
	data             []byte
	uncompressedSize uint64
}

func buildRawZip(t *testing.T, entries []rawZipEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		w, err := zw.CreateRaw(&zip.FileHeader{
			Name:               e.name,
			Method:             zip.Store,
			CompressedSize64:   uint64(len(e.data)),
			UncompressedSize64: e.uncompressedSize,
		})
		require.NoError(t, err)
		_, err = w.Write(e.data)
		require.NoError(t, err)
	}
	require.NoError(t, zw.Close())
	return buf.Bytes()
}

func TestImportBundleLimits(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "bundlelimits", "password123", false)
	emptyManifest := []byte(`{"format":"jot_export","version":2,"exported_at":"2026-01-01T00:00:00Z","notes":[]}`)

	t.Run("too many entries", func(t *testing.T) {
		files := map[string][]byte{client.JotExportManifest: emptyManifest}
		for i := range 20_001 {
			files[fmt.Sprintf("images/%d", i)] = nil
		}
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(buildZip(t, files)))
		require.Equal(t, http.StatusUnprocessableEntity, client.StatusCode(err))
		assert.Contains(t, err.Error(), "too many files")
	})

	t.Run("zip bomb", func(t *testing.T) {
		bundle := buildRawZip(t, []rawZipEntry{
			{name: client.JotExportManifest, data: emptyManifest, uncompressedSize: uint64(len(emptyManifest))},
			{name: "images/bomb.png", data: []byte("tiny"), uncompressedSize: 3 << 30},
		})
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(bundle))
		require.Equal(t, http.StatusUnprocessableEntity, client.StatusCode(err))
		assert.Contains(t, err.Error(), "too large when unpacked")
	})

	t.Run("oversized manifest", func(t *testing.T) {
		bundle := buildRawZip(t, []rawZipEntry{
			{name: client.JotExportManifest, data: emptyManifest, uncompressedSize: 65 << 20},
		})
		_, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(bundle))
		require.Equal(t, http.StatusUnprocessableEntity, client.StatusCode(err))
		assert.Contains(t, err.Error(), "notes.json is too large")
	})

	t.Run("image entry larger than it claims", func(t *testing.T) {
		manifest := textNoteManifest("liar", `[{"file":"images/liar.png","filename":"liar.png"}]`)
		bundle := buildRawZip(t, []rawZipEntry{
			{name: client.JotExportManifest, data: []byte(manifest), uncompressedSize: uint64(len(manifest))},
			{name: "images/liar.png", data: testPNG(t, 4, 4), uncompressedSize: 8},
		})
		result, err := user.Client.ImportNotes(t.Context(), "jot_json", "export.zip", bytes.NewReader(bundle))
		require.NoError(t, err)
		assert.Equal(t, 1, result.Imported)
		require.Len(t, result.Errors, 1)
		assert.Contains(t, result.Errors[0], "images/liar.png")
	})
}

func TestImportGoogleKeepSizeLimit(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "keepsizelimit", "password123", false)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	require.NoError(t, mw.WriteField("import_type", "google_keep"))
	part, err := mw.CreateFormFile("file", "takeout.zip")
	require.NoError(t, err)
	_, err = part.Write(bytes.Repeat([]byte{0}, 32<<20+1))
	require.NoError(t, err)
	require.NoError(t, mw.Close())

	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.HTTPServer.URL+"/api/v1/notes/import", &buf)
	require.NoError(t, err)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := user.Client.HTTPClient().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusRequestEntityTooLarge, resp.StatusCode)
}

func TestExportBundleManifestIsValidJSON(t *testing.T) {
	t.Parallel()
	ts := setupTestServer(t)
	user := ts.createTestUser(t, "exportmanifestjson", "password123", false)
	_, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "plain"})
	require.NoError(t, err)

	export, err := user.Client.ExportNotes(t.Context())
	require.NoError(t, err)
	var raw map[string]any
	require.NoError(t, json.Unmarshal(bundleEntries(t, export.Data)[client.JotExportManifest], &raw))
	assert.NotContains(t, raw["notes"].([]any)[0], "images", "notes without images omit the field")
}

func TestExportSkipsImagesMissingOnDisk(t *testing.T) {
	t.Parallel()
	var uploadDir string
	ts := setupTestServerWithConfig(t, func(cfg *config.Config) { uploadDir = cfg.UploadDir })
	user := ts.createTestUser(t, "exportmissingblob", "password123", false)

	note, err := user.Client.CreateTextNote(t.Context(), &client.CreateTextNoteRequest{Content: "lost image"})
	require.NoError(t, err)
	_, err = user.Client.UploadNoteImage(t.Context(), note.ID, "gone.png", bytes.NewReader(testPNG(t, 4, 4)))
	require.NoError(t, err)
	require.NoError(t, os.RemoveAll(filepath.Join(uploadDir, "blobs")))

	export, err := user.Client.ExportNotes(t.Context())
	require.NoError(t, err)
	require.Len(t, export.Manifest.Notes, 1)
	assert.Empty(t, export.Manifest.Notes[0].Images)
	assert.Len(t, bundleEntries(t, export.Data), 1, "only notes.json")
}
