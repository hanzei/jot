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

// publicNotesPathPrefix is the public note API, /api/v1/public/notes/{token}.
const publicNotesPathPrefix = "/api/v1/public/notes/"

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

// sharePreview is the index rewriter of the /share/* route (#1209). For an
// active public link at /share/{token} it returns index.html with the note's
// title and first image, and the fixed shareDescription, in the link-preview
// tags; for every other request, and every dead link (GetPublicNotePreview
// rejects a malformed token before querying), it returns index unchanged. The
// token never reaches a log line: it is a credential.
func (s *Server) sharePreview(r *http.Request, index []byte) []byte {
	token, ok := strings.CutPrefix(r.URL.Path, sharePathPrefix)
	if !s.cfg.PublicLinksEnabled || !ok {
		return index
	}

	preview, err := s.noteStore.GetPublicNotePreview(r.Context(), token)
	if err != nil {
		if !errors.Is(err, models.ErrPublicLinkNotFound) {
			logutil.FromContext(r.Context()).WithError(err).Error("Failed to look up public link preview")
		}
		return index
	}

	out, ok := renderSharePreview(index, preview, s.cfg.PublicURL, token)
	if !ok {
		logutil.FromContext(r.Context()).Error("Served index.html has no link-preview markers; falling back to the generic card")
		return index
	}
	return out
}

// renderSharePreview replaces index's preview blocks with the card of
// preview. publicURL is JOT_PUBLIC_URL, or "" when unset: og:image is then
// relative and og:url left out, since the spec requires it to be absolute and
// clients fall back to the URL that was pasted. It reports false when index
// lacks a marker.
func renderSharePreview(index []byte, preview *models.PublicNotePreview, publicURL, token string) ([]byte, bool) {
	title := strings.TrimSpace(preview.Title)
	if title == "" {
		title = shareFallbackTitle
	}
	title = html.EscapeString(title)

	text := []string{
		"<title>" + title + "</title>",
		metaTag("name", "description", shareDescription),
		metaTag("property", "og:title", title),
		metaTag("property", "og:description", shareDescription),
	}
	if publicURL != "" {
		text = append(text, metaTag("property", "og:url", html.EscapeString(publicURL+sharePathPrefix+token)))
	}
	out, ok := replaceBlock(index, previewTextStart, previewTextEnd, text)
	if !ok {
		return nil, false
	}
	// A note without images keeps the app icon and its small "summary" card.
	img := preview.FirstImage
	if img == nil {
		return out, true
	}

	thumbnailURL := publicURL + publicNotesPathPrefix + token + "/images/" + img.ID + "/thumbnail"
	image := []string{
		metaTag("property", "og:image", html.EscapeString(thumbnailURL)),
		metaTag("property", "og:image:type", "image/jpeg"),
	}
	if w, h := handlers.NoteImageThumbnailSize(img.Width, img.Height); w > 0 {
		image = append(image,
			metaTag("property", "og:image:width", strconv.Itoa(w)),
			metaTag("property", "og:image:height", strconv.Itoa(h)))
	}
	image = append(image,
		metaTag("property", "og:image:alt", title),
		// The note's own image is the point of the card, so ask for the large
		// layout (Discord, Telegram, X, Mastodon; Slack and Signal ignore it).
		metaTag("name", "twitter:card", "summary_large_image"))

	return replaceBlock(out, previewImageStart, previewImageEnd, image)
}

// metaTag renders a <meta> tag; content must already be HTML-escaped.
func metaTag(attr, key, content string) string {
	return `<meta ` + attr + `="` + key + `" content="` + content + `" />`
}

// replaceBlock returns src with everything from start through end, markers
// included, replaced by lines, indented like index.html's head. It reports
// false when either marker is missing.
func replaceBlock(src []byte, start, end string, lines []string) ([]byte, bool) {
	repl := strings.Join(lines, "\n    ")
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
