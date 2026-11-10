package server

import (
	"bytes"
	"errors"
	"html"
	"net/http"
	"strconv"
	"strings"

	"github.com/hanzei/jot/server/internal/handlers"
	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/models"
)

// sharePathPrefix is the webapp's public link viewer, /share/{token}.
const sharePathPrefix = "/share/"

// shareFallbackTitle titles the card of a note without a title (every text
// note). Static English, like the rest of index.html's preview tags: preview
// services do not run JS, so there is no locale to pick.
const shareFallbackTitle = "Shared note"

// shareDescription describes every share card: what the link is and what
// clicking does. Never anything from the note itself. Static English for the
// same reason as shareFallbackTitle.
const shareDescription = "A note shared from Jot. Open to view it."

// The marker comments around the two blocks of webapp/index.html that a share
// page's card replaces. webapp/vite.config.ts fails the build when the emitted
// index.html lost one, and TestSharePreviewMarkersInIndex checks the source.
const (
	previewTextStart  = "<!-- jot-preview:text -->"
	previewTextEnd    = "<!-- /jot-preview:text -->"
	previewImageStart = "<!-- jot-preview:image -->"
	previewImageEnd   = "<!-- /jot-preview:image -->"
)

// sharePreview is the SPA fallback's index rewriter (#1209). For an active
// public link at /share/{token} it returns index.html with the note's title
// and first image, and the fixed shareDescription, in the link-preview tags; for every other request, and every
// dead link, it returns nil so index.html is served byte for byte. The token
// never reaches a log line: it is a credential.
func (s *Server) sharePreview(r *http.Request, index []byte) []byte {
	if !s.cfg.PublicLinksEnabled {
		return nil
	}
	token, ok := strings.CutPrefix(r.URL.Path, sharePathPrefix)
	if !ok || !models.IsValidPublicLinkToken(token) {
		return nil
	}

	preview, err := s.noteStore.GetPublicNotePreview(r.Context(), token)
	if err != nil {
		if !errors.Is(err, models.ErrPublicLinkNotFound) {
			logutil.FromContext(r.Context()).WithError(err).Error("Failed to look up public link preview")
		}
		return nil
	}

	out, ok := renderSharePreview(index, preview, s.cfg.PublicURL, token)
	if !ok {
		logutil.FromContext(r.Context()).Error("Served index.html has no link-preview markers; falling back to the generic card")
		return nil
	}
	return out
}

// renderSharePreview replaces index's preview blocks with the card of
// preview. publicURL is JOT_PUBLIC_URL, or "" to keep URLs relative. It
// reports false when index lacks a marker.
func renderSharePreview(index []byte, preview *models.PublicNotePreview, publicURL, token string) ([]byte, bool) {
	title := strings.TrimSpace(preview.Title)
	if title == "" {
		title = shareFallbackTitle
	}
	esc := html.EscapeString

	var textBlock strings.Builder
	textBlock.WriteString("<title>" + esc(title) + "</title>\n")
	textBlock.WriteString(`    <meta name="description" content="` + shareDescription + `" />` + "\n")
	textBlock.WriteString(`    <meta property="og:title" content="` + esc(title) + `" />` + "\n")
	textBlock.WriteString(`    <meta property="og:description" content="` + shareDescription + `" />` + "\n")
	textBlock.WriteString(`    <meta property="og:url" content="` + esc(publicURL+sharePathPrefix+token) + `" />`)

	out, ok := replaceBlock(index, previewTextStart, previewTextEnd, textBlock.String())
	if !ok {
		return nil, false
	}
	// A note without images keeps the app icon.
	img := preview.FirstImage
	if img == nil {
		return out, true
	}

	thumbnailURL := publicURL + "/api/v1/public/notes/" + token + "/images/" + img.ID + "/thumbnail"
	var imageBlock strings.Builder
	imageBlock.WriteString(`<meta property="og:image" content="` + esc(thumbnailURL) + `" />` + "\n")
	imageBlock.WriteString(`    <meta property="og:image:type" content="image/jpeg" />` + "\n")
	if w, h := handlers.NoteImageThumbnailSize(img.Width, img.Height); w > 0 {
		imageBlock.WriteString(`    <meta property="og:image:width" content="` + strconv.Itoa(w) + `" />` + "\n")
		imageBlock.WriteString(`    <meta property="og:image:height" content="` + strconv.Itoa(h) + `" />` + "\n")
	}
	imageBlock.WriteString(`    <meta property="og:image:alt" content="` + esc(title) + `" />`)

	return replaceBlock(out, previewImageStart, previewImageEnd, imageBlock.String())
}

// replaceBlock returns src with everything from start through end, markers
// included, replaced by repl. It reports false when either marker is missing.
func replaceBlock(src []byte, start, end, repl string) ([]byte, bool) {
	before, rest, ok := bytes.Cut(src, []byte(start))
	if !ok {
		return nil, false
	}
	_, after, ok := bytes.Cut(rest, []byte(end))
	if !ok {
		return nil, false
	}
	out := make([]byte, 0, len(before)+len(repl)+len(after))
	out = append(out, before...)
	out = append(out, repl...)
	return append(out, after...), true
}
