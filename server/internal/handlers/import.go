package handlers

import (
	"archive/zip"
	"bytes"
	"context"
	jsonv1 "encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/models"
)

// ImportResponse reports the outcome of an import.
//
// Jot imports are all-or-nothing for notes: the whole bundle is validated up
// front and written in one transaction. Images are the exception: one that is
// missing from the bundle or fails the upload checks is left off its note and
// reported in Errors, without failing the import. Google Keep and usememos imports are
// best-effort per note: each note is validated and written in its own
// transaction (via ImportJotNotes), so a note is either imported complete —
// items, labels, pinned/archived state — or not at all, and a failing note is
// reported in Errors without discarding the others.
type ImportResponse struct {
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Errors   []string `json:"errors,omitempty"`
}

const (
	importTypeJotJSON    = "jot_json"
	importTypeGoogleKeep = "google_keep"
	importTypeUsememos   = "usememos"
	jotExportFormat      = "jot_export"
	// jotExportVersion 2 is the zip bundle with images. Version 1, a bare
	// JSON file without images, is no longer importable.
	jotExportVersion = 2
)

// Limits on an import request. Per the threat model these guard against
// accidental overload — a wrong file, a runaway script — not a hostile user.
const (
	// importMaxBytes caps the whole import request. It's sized for a Jot
	// bundle with images; the multipart parser spools a file that big to a
	// temp file rather than holding it in memory.
	importMaxBytes = int64(1 << 30)
	// importMaxMemoryBytes is how much of the upload is kept in memory before
	// the multipart parser spools it to disk.
	importMaxMemoryBytes = int64(32 << 20)
	// keepImportMaxBytes caps a Google Keep upload, which is read into memory
	// whole.
	keepImportMaxBytes = int64(32 << 20)

	// jotBundleMaxEntries, jotBundleMaxUncompressedBytes and
	// jotManifestMaxBytes bound the work a bundle can cause (a zip bomb, or
	// a zip of something else entirely) before any of it is read. Every
	// entry is then also read through a limit, since the sizes a zip
	// declares can't be trusted on their own.
	jotBundleMaxEntries           = 20_000
	jotBundleMaxUncompressedBytes = uint64(2 << 30)
	jotManifestMaxBytes           = int64(64 << 20)

	// importImageFilenameMaxLength bounds an imported image's display name.
	importImageFilenameMaxLength = 255
)

// --- Jot import types (the notes.json manifest of a bundle) ---

type jotImportNoteItem struct {
	Text        string `json:"text"`
	Completed   bool   `json:"completed"`
	Position    int    `json:"position"`
	IndentLevel int    `json:"indent_level"`
}

type jotImportNote struct {
	Title                 string              `json:"title"`
	Content               string              `json:"content"`
	NoteType              models.NoteType     `json:"note_type"`
	Color                 string              `json:"color"`
	Pinned                bool                `json:"pinned"`
	Archived              bool                `json:"archived"`
	Position              int                 `json:"position"`
	UnpinnedPosition      *int                `json:"unpinned_position"`
	CheckedItemsCollapsed bool                `json:"checked_items_collapsed"`
	Labels                []string            `json:"labels"`
	Items                 []jotImportNoteItem `json:"items"`
	Images                []jotImportImage    `json:"images"`
}

type jotImportImage struct {
	File      string    `json:"file"`
	Filename  string    `json:"filename"`
	CreatedAt time.Time `json:"created_at"`
}

type jotImportEnvelope struct {
	Format  string          `json:"format"`
	Version int             `json:"version"`
	Notes   []jotImportNote `json:"notes"`
}

// importJotBundle imports a Jot export bundle (see ExportNotes). It returns
// the response, or an HTTP status and error when the import is rejected as a
// whole.
func (h *NotesHandler) importJotBundle(ctx context.Context, userID string, file multipart.File, size int64) (*ImportResponse, int, error) {
	entries, raw, status, err := openJotBundle(file, size)
	if err != nil {
		return nil, status, err
	}

	importNotes := make([]models.JotImportNote, 0, len(raw.Notes))
	for i, n := range raw.Notes {
		importNote, validateErr := validateJotImportNote(i+1, n)
		if validateErr != nil {
			return nil, http.StatusBadRequest, validateErr
		}
		importNotes = append(importNotes, importNote)
	}

	// Validate every note before storing any image, so a bundle rejected for
	// a bad note writes nothing to disk.
	images := &bundleImageImporter{h: h, entries: entries, stored: make(map[string]models.JotImportImage)}
	defer images.releasePins()
	for i, n := range raw.Notes {
		importNotes[i].Images, err = images.importNoteImages(ctx, i+1, n.Images)
		if err != nil {
			images.rollback(ctx)
			return nil, http.StatusInternalServerError, err
		}
	}

	if err := h.noteStore.ImportJotNotes(ctx, userID, importNotes); err != nil {
		images.rollback(ctx)
		return nil, http.StatusInternalServerError, fmt.Errorf("import jot notes: %w", err)
	}
	return &ImportResponse{Imported: len(importNotes), Errors: images.errors}, http.StatusOK, nil
}

// openJotBundle checks the bundle's limits and reads its manifest. It returns
// the bundle's entries by name and the parsed manifest, or an HTTP status and
// error rejecting the bundle.
func openJotBundle(file multipart.File, size int64) (map[string]*zip.File, *jotImportEnvelope, int, error) {
	zr, err := zip.NewReader(file, size)
	if err != nil {
		if looksLikeJSON(file) {
			return nil, nil, http.StatusBadRequest, errors.New("this is a JSON export from an older version of Jot, which can no longer be imported: import a .zip export instead")
		}
		return nil, nil, http.StatusBadRequest, errors.New("invalid Jot export: not a zip file")
	}

	if len(zr.File) > jotBundleMaxEntries {
		return nil, nil, http.StatusUnprocessableEntity, fmt.Errorf("export has too many files (max %d)", jotBundleMaxEntries)
	}
	entries := make(map[string]*zip.File, len(zr.File))
	var uncompressed uint64
	for _, f := range zr.File {
		uncompressed += f.UncompressedSize64
		if _, dup := entries[f.Name]; !dup {
			entries[f.Name] = f
		}
	}
	if uncompressed > jotBundleMaxUncompressedBytes {
		return nil, nil, http.StatusUnprocessableEntity, fmt.Errorf("export is too large when unpacked (max %d bytes)", jotBundleMaxUncompressedBytes)
	}

	manifest, ok := entries[jotBundleManifest]
	if !ok {
		return nil, nil, http.StatusBadRequest, fmt.Errorf("invalid Jot export: %s is missing", jotBundleManifest)
	}
	data, err := readZipEntry(manifest, jotManifestMaxBytes)
	if errors.Is(err, errZipEntryTooLarge) {
		return nil, nil, http.StatusUnprocessableEntity, fmt.Errorf("%s is too large (max %d bytes)", jotBundleManifest, jotManifestMaxBytes)
	}
	if err != nil {
		return nil, nil, http.StatusBadRequest, fmt.Errorf("invalid Jot export: read %s: %w", jotBundleManifest, err)
	}

	var raw jotImportEnvelope
	if err := jsonv1.Unmarshal(data, &raw); err != nil {
		return nil, nil, http.StatusBadRequest, fmt.Errorf("invalid Jot export: %s is not valid JSON", jotBundleManifest)
	}
	if raw.Format != jotExportFormat {
		return nil, nil, http.StatusBadRequest, fmt.Errorf("invalid format %q: expected jot_export", raw.Format)
	}
	if raw.Version != jotExportVersion {
		return nil, nil, http.StatusBadRequest, fmt.Errorf("unsupported version %d: only version %d is supported", raw.Version, jotExportVersion)
	}
	if raw.Notes == nil {
		return nil, nil, http.StatusBadRequest, errors.New("notes must be a JSON array")
	}
	return entries, &raw, 0, nil
}

// looksLikeJSON reports whether f starts with a JSON object, i.e. is most
// likely a version 1 export.
func looksLikeJSON(f io.ReaderAt) bool {
	buf := make([]byte, 512)
	n, _ := f.ReadAt(buf, 0)
	trimmed := bytes.TrimLeft(buf[:n], " \t\r\n\ufeff")
	return len(trimmed) > 0 && trimmed[0] == '{'
}

var errZipEntryTooLarge = errors.New("zip entry too large")

// readZipEntry reads f whole, failing with errZipEntryTooLarge beyond
// maxBytes. The declared size is checked first to fail fast, and the read is
// bounded as well, since the declared size is only what the zip claims.
func readZipEntry(f *zip.File, maxBytes int64) ([]byte, error) {
	if f.UncompressedSize64 > uint64(maxBytes) { //nolint:gosec // maxBytes is a positive size limit
		return nil, errZipEntryTooLarge
	}
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer func() { _ = rc.Close() }()
	data, err := io.ReadAll(io.LimitReader(rc, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, errZipEntryTooLarge
	}
	return data, nil
}

// bundleImageImporter stores the images of a Jot bundle being imported. It
// runs each image through the same checks as UploadNoteImage, and keeps its
// hash pinned until the import has committed or failed, so the orphan sweep
// can't reclaim a blob whose row isn't written yet. An entry referenced by
// several notes is read and checked once.
type bundleImageImporter struct {
	h       *NotesHandler
	entries map[string]*zip.File
	// stored and rejected cache the outcome per bundle entry.
	stored   map[string]models.JotImportImage
	rejected map[string]string
	releases []func()
	shas     []string
	errors   []string
}

// importNoteImages stores the images of note #noteIdx and returns them in
// their bundle order. A bad image is skipped and recorded in b.errors; the
// returned error is reserved for failures that must abort the import.
func (b *bundleImageImporter) importNoteImages(ctx context.Context, noteIdx int, refs []jotImportImage) ([]models.JotImportImage, error) {
	if len(refs) > imageMaxPerNote {
		b.errors = append(b.errors, fmt.Sprintf("note #%d: has %d images; only the first %d were imported", noteIdx, len(refs), imageMaxPerNote))
		refs = refs[:imageMaxPerNote]
	}
	images := make([]models.JotImportImage, 0, len(refs))
	for j, ref := range refs {
		img, reason, err := b.storeEntry(ctx, ref.File)
		if err != nil {
			return nil, err
		}
		if reason != "" {
			b.errors = append(b.errors, fmt.Sprintf("note #%d image #%d (%s): skipped: %s", noteIdx, j+1, ref.File, reason))
			continue
		}
		img.Filename = importImageFilename(ref.Filename, ref.File)
		img.CreatedAt = ref.CreatedAt
		images = append(images, img)
	}
	return images, nil
}

// storeEntry stores the image in bundle entry file. It returns the reason
// when the entry is not an acceptable image, and an error only when storing
// it failed.
func (b *bundleImageImporter) storeEntry(ctx context.Context, file string) (models.JotImportImage, string, error) {
	if img, ok := b.stored[file]; ok {
		return img, "", nil
	}
	if reason, ok := b.rejected[file]; ok {
		return models.JotImportImage{}, reason, nil
	}
	reject := func(reason string) (models.JotImportImage, string, error) {
		if b.rejected == nil {
			b.rejected = make(map[string]string)
		}
		b.rejected[file] = reason
		return models.JotImportImage{}, reason, nil
	}

	f, ok := b.entries[file]
	if !ok || !strings.HasPrefix(file, jotBundleImageDir) {
		return reject("file not found in export")
	}
	data, err := readZipEntry(f, b.h.uploadMaxBytes)
	if errors.Is(err, errZipEntryTooLarge) {
		return reject(fmt.Sprintf("larger than the %d byte upload limit", b.h.uploadMaxBytes))
	}
	if err != nil {
		return reject(fmt.Sprintf("unreadable: %v", err))
	}
	inspected, err := inspectNoteImage(data)
	if err != nil {
		return reject(err.Error())
	}

	release, err := b.h.storeNoteImage(ctx, inspected)
	if err != nil {
		return models.JotImportImage{}, "", err
	}
	b.releases = append(b.releases, release)
	b.shas = append(b.shas, inspected.sha)

	img := models.JotImportImage{
		ContentType: inspected.contentType,
		SizeBytes:   int64(len(data)),
		SHA256:      inspected.sha,
		Width:       inspected.width,
		Height:      inspected.height,
	}
	b.stored[file] = img
	return img, "", nil
}

func (b *bundleImageImporter) releasePins() {
	for _, release := range b.releases {
		release()
	}
}

// rollback reclaims every blob stored so far, after a failure that means
// none of their rows will be written. A blob another row already shares
// (dedup) is left alone.
func (b *bundleImageImporter) rollback(ctx context.Context) {
	b.releasePins() // reclaim skips pinned hashes
	reclaimOrphanedImageBlobs(ctx, b.h.noteStore, b.h.imageStore, b.shas)
}

// importImageFilename returns the display name to store for an imported
// image: the exported filename, cut down to a base name of bounded length,
// or the bundle entry's own name when the export didn't carry a usable one.
func importImageFilename(filename, file string) string {
	name := path.Base(strings.ReplaceAll(filename, "\\", "/"))
	if name == "." || name == "/" || !utf8.ValidString(name) {
		name = path.Base(file)
	}
	if runes := []rune(name); len(runes) > importImageFilenameMaxLength {
		name = string(runes[:importImageFilenameMaxLength])
	}
	return name
}

// validateJotImportNote validates a single note from a Jot export and converts
// it to the store import type. idx is 1-based and used only in error messages.
func validateJotImportNote(idx int, n jotImportNote) (models.JotImportNote, error) {
	if !n.NoteType.Valid() {
		return models.JotImportNote{}, fmt.Errorf("note #%d: unsupported note_type %q", idx, n.NoteType)
	}
	if utf8.RuneCountInString(n.Title) > noteTitleMaxLength {
		return models.JotImportNote{}, fmt.Errorf("note #%d: title exceeds %d character limit", idx, noteTitleMaxLength)
	}
	if utf8.RuneCountInString(n.Content) > noteContentMaxLength {
		return models.JotImportNote{}, fmt.Errorf("note #%d: content exceeds %d character limit", idx, noteContentMaxLength)
	}
	if n.Position < 0 {
		return models.JotImportNote{}, fmt.Errorf("note #%d: position must be non-negative", idx)
	}
	if n.UnpinnedPosition != nil && *n.UnpinnedPosition < 0 {
		return models.JotImportNote{}, fmt.Errorf("note #%d: unpinned_position must be non-negative", idx)
	}

	color := n.Color
	if color == "" {
		color = models.DefaultNoteColor
	}
	if err := validateColor(color); err != nil {
		return models.JotImportNote{}, fmt.Errorf("note #%d: %w", idx, err)
	}

	// Silently strip mismatched fields — import is a migration path, not a strict
	// API endpoint, so we coerce rather than reject to maximize import success.
	if n.NoteType == models.NoteTypeText {
		n.Title = ""
		n.CheckedItemsCollapsed = false
	}
	if n.NoteType == models.NoteTypeList {
		n.Content = ""
	}

	// Items on a text note can't be silently discarded without data loss (they
	// require DB writes), so reject rather than coerce.
	if n.NoteType == models.NoteTypeText && len(n.Items) > 0 {
		return models.JotImportNote{}, fmt.Errorf("note #%d: text notes cannot have items", idx)
	}
	if len(n.Items) > noteItemsMaxCount {
		return models.JotImportNote{}, fmt.Errorf("note #%d: too many items (max %d)", idx, noteItemsMaxCount)
	}

	importItems, err := validateJotImportItems(idx, n.Items)
	if err != nil {
		return models.JotImportNote{}, err
	}

	return models.JotImportNote{
		Title:                 n.Title,
		Content:               n.Content,
		NoteType:              n.NoteType,
		Color:                 color,
		Pinned:                n.Pinned,
		Archived:              n.Archived,
		Position:              n.Position,
		UnpinnedPosition:      n.UnpinnedPosition,
		CheckedItemsCollapsed: n.CheckedItemsCollapsed,
		Labels:                normalizeLabels(n.Labels),
		Items:                 importItems,
	}, nil
}

func validateJotImportItems(noteIdx int, items []jotImportNoteItem) ([]models.JotImportNoteItem, error) {
	result := make([]models.JotImportNoteItem, 0, len(items))
	for j, item := range items {
		jdx := j + 1
		if utf8.RuneCountInString(item.Text) > noteItemTextMaxLength {
			return nil, fmt.Errorf("note #%d item #%d: text exceeds %d character limit", noteIdx, jdx, noteItemTextMaxLength)
		}
		if item.IndentLevel < 0 || item.IndentLevel > 1 {
			return nil, fmt.Errorf("note #%d item #%d: indent_level must be 0 or 1", noteIdx, jdx)
		}
		if item.Position < 0 {
			return nil, fmt.Errorf("note #%d item #%d: position must be non-negative", noteIdx, jdx)
		}
		result = append(result, models.JotImportNoteItem{
			Text:        item.Text,
			Completed:   item.Completed,
			Position:    item.Position,
			IndentLevel: item.IndentLevel,
		})
	}
	return result, nil
}

// ImportNotes godoc
//
//	@Summary		Import notes from a supported export format
//	@Tags			notes
//	@Security		CookieAuth
//	@Accept			multipart/form-data
//	@Produce		json
//	@Description	jot_json takes a Jot export bundle (.zip, as produced by GET /notes/export) of up to 1 GiB; a bare JSON file from an older export is rejected. Notes are imported all-or-nothing; an image that is missing or invalid is left off its note and listed in errors. google_keep takes a Takeout .zip or a single .json file of up to 32 MiB.
//	@Param			import_type	formData	string	true	"Import format: jot_json or google_keep (requires file); usememos (requires url and token)"
//	@Param			file		formData	file	false	"Export file (required when import_type is jot_json or google_keep)"
//	@Param			url			formData	string	false	"Memos instance URL (required when import_type is usememos)"
//	@Param			token		formData	string	false	"Memos API token (required when import_type is usememos)"
//	@Success		200			{object}	ImportResponse
//	@Failure		400			{string}	string	"bad request"
//	@Failure		401			{string}	string	"unauthorized"
//	@Failure		413			{string}	string	"file too large"
//	@Failure		422			{string}	string	"export exceeds a size or file-count limit"
//	@Failure		500			{string}	string	"internal server error"
//	@Router			/notes/import [post]
func (h *NotesHandler) ImportNotes(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	// A bundle can take far longer to upload and process than the server-wide
	// timeouts allow for; lift both for this request only. The write deadline
	// matters too: the server starts it when the request headers arrive, so
	// it would otherwise expire before the response is written.
	//nolint:gocritic // a connection deadline, not a stored timestamp
	deadline := time.Now().Add(jotBundleTransferTimeout)
	rc := http.NewResponseController(w)
	if err := rc.SetReadDeadline(deadline); err != nil {
		logutil.FromContext(r.Context()).WithError(err).Warn("ImportNotes: could not extend read deadline")
	}
	if err := rc.SetWriteDeadline(deadline); err != nil {
		logutil.FromContext(r.Context()).WithError(err).Warn("ImportNotes: could not extend write deadline")
	}

	r.Body = http.MaxBytesReader(w, r.Body, importMaxBytes+multipartOverheadBytes)
	//nolint:gosec // r.Body is already bounded by the MaxBytesReader above
	if err := r.ParseMultipartForm(importMaxMemoryBytes); err != nil {
		// wrapHandler promotes a wrapped *http.MaxBytesError to 413.
		return http.StatusBadRequest, nil, fmt.Errorf("invalid multipart form: %w", err)
	}

	importType := r.FormValue("import_type")
	switch importType {
	case importTypeJotJSON, importTypeGoogleKeep, importTypeUsememos:
		// valid
	case "":
		return http.StatusBadRequest, nil, errors.New("missing import_type")
	default:
		return http.StatusBadRequest, nil, fmt.Errorf("unsupported import_type %q", importType)
	}

	if importType == importTypeUsememos {
		rawURL := r.FormValue("url")
		token := r.FormValue("token")
		if rawURL == "" || token == "" {
			return http.StatusBadRequest, nil, errors.New("url and token are required for usememos import")
		}
		parsed, err := url.Parse(rawURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return http.StatusBadRequest, nil, errors.New("url must be a valid http or https URL")
		}
		imported, skipped, importErrors := h.importMemosFromUsememos(r.Context(), user.ID, rawURL, token)
		return http.StatusOK, ImportResponse{Imported: imported, Skipped: skipped, Errors: importErrors}, nil
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		return http.StatusBadRequest, nil, errors.New("missing file")
	}
	defer func() { _ = file.Close() }()

	if importType == importTypeJotJSON {
		resp, status, importErr := h.importJotBundle(r.Context(), user.ID, file, header.Size)
		if importErr != nil {
			return status, nil, importErr
		}
		return http.StatusOK, resp, nil
	}

	// google_keep
	if header.Size > keepImportMaxBytes {
		return http.StatusRequestEntityTooLarge, nil, fmt.Errorf("google keep import is limited to %d bytes", keepImportMaxBytes)
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}
	keepNotes, err := parseKeepNotesFromData(header.Filename, data)
	if err != nil {
		return http.StatusBadRequest, nil, err
	}
	imported, skipped, importErrors := h.importKeepNotes(r.Context(), user.ID, keepNotes)
	return http.StatusOK, ImportResponse{Imported: imported, Skipped: skipped, Errors: importErrors}, nil
}
