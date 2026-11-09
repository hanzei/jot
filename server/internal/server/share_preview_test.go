package server

import (
	"os"
	"strings"
	"testing"

	"github.com/hanzei/jot/server/internal/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// webappIndexPath is the source index.html the build emits (with its preview
// markers intact; vite.config.ts guards the build output).
const webappIndexPath = "../../../webapp/index.html"

func readWebappIndex(t *testing.T) []byte {
	t.Helper()
	index, err := os.ReadFile(webappIndexPath)
	require.NoError(t, err)
	return index
}

func TestSharePreviewMarkersInIndex(t *testing.T) {
	t.Parallel()
	index := string(readWebappIndex(t))

	for _, block := range [][2]string{{previewTitleStart, previewTitleEnd}, {previewImageStart, previewImageEnd}} {
		require.Equal(t, 1, strings.Count(index, block[0]), "marker %s", block[0])
		require.Equal(t, 1, strings.Count(index, block[1]), "marker %s", block[1])
		assert.Less(t, strings.Index(index, block[0]), strings.Index(index, block[1]), "%s comes before its end marker", block[0])
	}
	title := index[strings.Index(index, previewTitleStart):strings.Index(index, previewTitleEnd)]
	assert.Contains(t, title, "<title>")
	assert.Contains(t, title, `property="og:title"`)
	image := index[strings.Index(index, previewImageStart):strings.Index(index, previewImageEnd)]
	assert.Contains(t, image, `property="og:image"`)
	assert.Contains(t, image, `property="og:image:alt"`)
}

func TestRenderSharePreview(t *testing.T) {
	t.Parallel()
	index := readWebappIndex(t)
	token := strings.Repeat("a", 43)

	t.Run("title and image", func(t *testing.T) {
		t.Parallel()
		out, ok := renderSharePreview(index, &models.PublicNotePreview{
			Title:      "Groceries",
			FirstImage: &models.NoteImage{ID: "img1", Width: 2048, Height: 1024},
		}, "https://jot.example.com", token)
		require.True(t, ok)
		html := string(out)
		assert.Contains(t, html, "<title>Groceries</title>")
		assert.Contains(t, html, `<meta property="og:title" content="Groceries" />`)
		assert.Contains(t, html, `<meta property="og:url" content="https://jot.example.com/share/`+token+`" />`)
		assert.Contains(t, html, `<meta property="og:image" content="https://jot.example.com/api/v1/public/notes/`+token+`/images/img1/thumbnail" />`)
		assert.Contains(t, html, `<meta property="og:image:type" content="image/jpeg" />`)
		assert.Contains(t, html, `<meta property="og:image:width" content="512" />`)
		assert.Contains(t, html, `<meta property="og:image:height" content="256" />`)
		assert.Contains(t, html, `<meta property="og:image:alt" content="Groceries" />`)
		assert.NotContains(t, html, "Jot - Your Notes")
		assert.NotContains(t, html, "pwa-512x512.png")
		assert.NotContains(t, html, "jot-preview:", "the markers go with the blocks they mark")
		assert.Contains(t, html, `<meta name="description" content="Jot is a self-hosted app for notes, lists and tasks." />`)
	})

	t.Run("no image keeps the app icon", func(t *testing.T) {
		t.Parallel()
		out, ok := renderSharePreview(index, &models.PublicNotePreview{Title: "List"}, "", token)
		require.True(t, ok)
		html := string(out)
		assert.Contains(t, html, `<meta property="og:url" content="/share/`+token+`" />`)
		img := string(index[strings.Index(string(index), previewImageStart):])
		img = img[:strings.Index(img, previewImageEnd)+len(previewImageEnd)]
		assert.Contains(t, html, img, "the image block is untouched")
	})

	t.Run("small image keeps its size; unknown size has no size tags", func(t *testing.T) {
		t.Parallel()
		out, ok := renderSharePreview(index, &models.PublicNotePreview{FirstImage: &models.NoteImage{ID: "a", Width: 300, Height: 200}}, "", token)
		require.True(t, ok)
		assert.Contains(t, string(out), `<meta property="og:image:width" content="300" />`)
		assert.Contains(t, string(out), `<meta property="og:image:height" content="200" />`)

		out, ok = renderSharePreview(index, &models.PublicNotePreview{FirstImage: &models.NoteImage{ID: "a"}}, "", token)
		require.True(t, ok)
		assert.NotContains(t, string(out), "og:image:width")
		assert.NotContains(t, string(out), "og:image:height")
	})

	t.Run("missing markers", func(t *testing.T) {
		t.Parallel()
		_, ok := renderSharePreview([]byte("<html></html>"), &models.PublicNotePreview{}, "", token)
		assert.False(t, ok)
		noImageEnd := strings.Replace(string(index), previewImageEnd, "", 1)
		_, ok = renderSharePreview([]byte(noImageEnd), &models.PublicNotePreview{FirstImage: &models.NoteImage{ID: "a"}}, "", token)
		assert.False(t, ok)
	})
}
