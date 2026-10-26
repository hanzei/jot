package handlers

import (
	"archive/zip"
	"context"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"time"

	"github.com/hanzei/jot/server/internal/blobstore"
	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/models"
)

// A Jot export is a zip bundle: the notes as JSON in jotBundleManifest, plus
// one entry per distinct image under jotBundleImageDir, which the notes
// reference by entry name. Images are stored rather than deflated — they're
// already compressed, so deflating would only cost CPU.
const (
	// exportFormatJot and exportFormatMarkdown are the values of
	// GET /notes/export?format=; an absent format means exportFormatJot.
	exportFormatJot      = "jot"
	exportFormatMarkdown = "markdown"

	jotBundleManifest = "notes.json"
	jotBundleImageDir = "images/"

	// jotBundleTransferTimeout replaces the server-wide 30s read/write
	// timeout for the export download and import upload, which can be
	// hundreds of megabytes. It still ends a stalled transfer eventually.
	jotBundleTransferTimeout = 30 * time.Minute
)

// jotBundleImageExt is the file extension of an image entry in the bundle, by
// content type. It's cosmetic (import sniffs the bytes) but makes an unzipped
// bundle browsable.
var jotBundleImageExt = map[string]string{
	mimeTypePNG:  ".png",
	mimeTypeJPEG: ".jpg",
	mimeTypeWebP: ".webp",
	mimeTypeGIF:  ".gif",
}

type jotExportNoteItem struct {
	Text        string `json:"text"`
	Completed   bool   `json:"completed"`
	Position    int    `json:"position"`
	IndentLevel int    `json:"indent_level"`
}

type jotExportImage struct {
	File        string    `json:"file"`
	Filename    string    `json:"filename"`
	ContentType string    `json:"content_type"`
	CreatedAt   time.Time `json:"created_at"`
}

type jotExportNote struct {
	Title                 string              `json:"title"`
	Content               string              `json:"content"`
	NoteType              models.NoteType     `json:"note_type"`
	Color                 string              `json:"color"`
	Pinned                bool                `json:"pinned"`
	Archived              bool                `json:"archived"`
	Position              int                 `json:"position"`
	UnpinnedPosition      *int                `json:"unpinned_position,omitzero"`
	CheckedItemsCollapsed bool                `json:"checked_items_collapsed,omitzero"`
	Labels                []string            `json:"labels"`
	Items                 []jotExportNoteItem `json:"items,omitempty"`
	Images                []jotExportImage    `json:"images,omitempty"`
	CreatedAt             time.Time           `json:"created_at"`
	UpdatedAt             time.Time           `json:"updated_at"`
}

type jotExportEnvelope struct {
	Format     string          `json:"format"`
	Version    int             `json:"version"`
	ExportedAt time.Time       `json:"exported_at"`
	Notes      []jotExportNote `json:"notes"`
}

// ExportNotes godoc
//
//	@Summary		Export notes as a zip
//	@Description	format=jot (the default) is a Jot backup bundle: a zip file holding notes.json (the notes, format jot_export version 2) and an images/ folder with every image attached to the exported notes. Each note carries its created_at and updated_at, which import restores.
//	@Description	format=markdown is a plain-Markdown folder that opens as an Obsidian vault: one notes/<slug>.md per note, with labels, color, pinned, archived, note type and timestamps in YAML front-matter, list notes written as task lists, and images in a shared images/ folder linked as ../images/<sha256>.<ext>. Jot cannot import it back.
//	@Description	Either format covers the notes the user owns, including images collaborators added to them.
//	@Tags			notes
//	@Security		CookieAuth
//	@Param			format	query	string	false	"Export format"	Enums(jot, markdown)	default(jot)
//	@Produce		application/zip
//	@Success		200	{file}		binary					"Export (zip) attachment"
//	@Failure		400	{object}	apierr.ErrorResponse	"unknown format"
//	@Failure		401	{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure		500	{object}	apierr.ErrorResponse	"internal server error"
//	@Router			/notes/export [get]
func (h *NotesHandler) ExportNotes(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, authErr := requireUser(r)
	if authErr != nil {
		return http.StatusUnauthorized, nil, authErr
	}

	format := r.URL.Query().Get("format")
	switch format {
	case "", exportFormatJot, exportFormatMarkdown:
	default:
		return http.StatusBadRequest, nil, fmt.Errorf("unknown export format %q: use %q or %q", format, exportFormatJot, exportFormatMarkdown)
	}

	notes, err := h.noteStore.GetOwnedNotesForExport(r.Context(), user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("export notes: %w", err)
	}

	now := models.Now()

	if format == exportFormatMarkdown {
		h.streamExport(w, r, "jot-markdown-export-"+now.Format("2006-01-02T15-04-05Z")+".zip", func(ctx context.Context, w io.Writer) error {
			return h.writeMarkdownBundle(ctx, w, notes, now)
		})
		return 0, nil, nil
	}

	exportNotes := make([]jotExportNote, 0, len(notes))
	for _, n := range notes {
		exportNote := jotExportNote{
			NoteType:         n.NoteType,
			Color:            n.Color,
			Pinned:           n.Pinned,
			Archived:         n.Archived,
			Position:         n.Position,
			UnpinnedPosition: n.UnpinnedPosition,
			Labels:           make([]string, 0, len(n.Labels)),
			CreatedAt:        n.CreatedAt,
			UpdatedAt:        n.UpdatedAt,
		}
		// Populate only the fields that belong to this note type so that
		// re-importing the export does not carry mismatched data.
		switch n.NoteType {
		case models.NoteTypeList:
			exportNote.Title = n.Title
			exportNote.CheckedItemsCollapsed = n.CheckedItemsCollapsed
			exportNote.Items = make([]jotExportNoteItem, 0, len(n.Items))
			for _, item := range n.Items {
				// indent_level is derived from grouping: a child (parent_id set)
				// is one level deep, a top-level item is zero.
				indentLevel := 0
				if item.ParentID != nil {
					indentLevel = 1
				}
				exportNote.Items = append(exportNote.Items, jotExportNoteItem{
					Text:        item.Text,
					Completed:   item.Completed,
					Position:    item.Position,
					IndentLevel: indentLevel,
				})
			}
		case models.NoteTypeText:
			exportNote.Content = n.Content
		default:
			logutil.FromContext(r.Context()).Warnf("ExportNotes: unknown note type %q for note %s", n.NoteType, n.ID)
		}
		for _, l := range n.Labels {
			exportNote.Labels = append(exportNote.Labels, l.Name)
		}
		exportNotes = append(exportNotes, exportNote)
	}

	h.streamExport(w, r, "jot-export-"+now.Format("2006-01-02T15-04-05Z")+".zip", func(ctx context.Context, w io.Writer) error {
		return h.writeExportBundle(ctx, w, notes, exportNotes, now)
	})
	return 0, nil, nil
}

// streamExport sends the zip that write produces as an attachment named
// filename.
func (h *NotesHandler) streamExport(w http.ResponseWriter, r *http.Request, filename string, write func(context.Context, io.Writer) error) {
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))

	// The bundle can be far larger than the server-wide write timeout allows
	// for; lift it for this response only.
	//nolint:gocritic // a connection deadline, not a stored timestamp
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(jotBundleTransferTimeout)); err != nil {
		logutil.FromContext(r.Context()).WithError(err).Warn("ExportNotes: could not extend write deadline")
	}
	w.WriteHeader(http.StatusOK)

	if err := write(r.Context(), w); err != nil {
		// The 200 and part of the zip are already on the wire, so there's no
		// status left to report this with. Abort the connection instead of
		// ending the response normally: the client then sees a failed
		// download rather than a truncated file it might keep as a backup.
		logutil.FromContext(r.Context()).WithError(err).Error("Failed to write export bundle")
		panic(http.ErrAbortHandler)
	}
}

// writeExportBundle writes the export zip to w: each distinct image once,
// then the manifest, whose notes reference the images by entry name.
// exportNotes[i] is the export form of notes[i]; its Images are filled in
// here.
func (h *NotesHandler) writeExportBundle(ctx context.Context, w io.Writer, notes []*models.Note, exportNotes []jotExportNote, now time.Time) error {
	zw := zip.NewWriter(w)

	images, err := h.writeBundleImages(ctx, zw, notes, now)
	if err != nil {
		return fmt.Errorf("write images: %w", err)
	}
	for i := range exportNotes {
		exportNotes[i].Images = images[i]
	}

	mw, err := zw.CreateHeader(&zip.FileHeader{Name: jotBundleManifest, Method: zip.Deflate, Modified: now})
	if err != nil {
		return fmt.Errorf("create manifest entry: %w", err)
	}
	export := jotExportEnvelope{
		Format:     jotExportFormat,
		Version:    jotExportVersion,
		ExportedAt: now,
		Notes:      exportNotes,
	}
	if err := json.MarshalWrite(mw, export); err != nil {
		return fmt.Errorf("write manifest: %w", err)
	}
	return zw.Close()
}

// writeBundleImages writes each distinct image of notes into zw once, under
// jotBundleImageDir, and returns the entries notes[i] references as
// images[i]. An image whose blob is missing from disk (e.g. after restoring a
// database and upload directory backed up at different times) is left out
// and logged rather than failing the whole export.
func (h *NotesHandler) writeBundleImages(ctx context.Context, zw *zip.Writer, notes []*models.Note, now time.Time) ([][]jotExportImage, error) {
	images := make([][]jotExportImage, len(notes))
	written := make(map[string]string) // sha256 -> entry name
	missing := make(map[string]bool)   // sha256 -> blob not on disk
	for i, n := range notes {
		for _, img := range n.Images {
			if missing[img.SHA256] {
				continue
			}
			file, ok := written[img.SHA256]
			if !ok {
				file = jotBundleImageDir + img.SHA256 + jotBundleImageExt[img.ContentType]
				copied, err := h.copyImageToBundle(ctx, zw, file, img, now)
				if err != nil {
					return nil, err
				}
				if !copied {
					missing[img.SHA256] = true
					continue
				}
				written[img.SHA256] = file
			}
			images[i] = append(images[i], jotExportImage{
				File:        file,
				Filename:    img.Filename,
				ContentType: img.ContentType,
				CreatedAt:   img.CreatedAt,
			})
		}
	}
	return images, nil
}

// copyImageToBundle copies img's blob into the bundle as entry file. It
// reports false, having written nothing, when the blob is missing.
func (h *NotesHandler) copyImageToBundle(ctx context.Context, zw *zip.Writer, file string, img models.NoteImage, now time.Time) (bool, error) {
	blob, err := h.imageStore.Open(ctx, img.SHA256)
	if errors.Is(err, blobstore.ErrNotFound) {
		logutil.FromContext(ctx).WithField("sha256", img.SHA256).WithField("note_id", img.NoteID).
			Warn("ExportNotes: image blob missing from disk; leaving it out of the export")
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("open image blob %s: %w", img.SHA256, err)
	}
	defer func() { _ = blob.Close() }()

	ew, err := zw.CreateHeader(&zip.FileHeader{Name: file, Method: zip.Store, Modified: now})
	if err != nil {
		return false, fmt.Errorf("create image entry: %w", err)
	}
	if _, err := io.Copy(ew, blob); err != nil {
		return false, fmt.Errorf("copy image blob %s: %w", img.SHA256, err)
	}
	return true, nil
}
