package handlers

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
)

type ImportResponse struct {
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Errors   []string `json:"errors,omitempty"`
}

// --- Google Keep import types ---

type keepNoteItem struct {
	Text      string `json:"text"`
	IsChecked bool   `json:"isChecked"`
}

type keepNote struct {
	Title       string         `json:"title"`
	TextContent string         `json:"textContent"`
	ListContent []keepNoteItem `json:"listContent"`
	Color       string         `json:"color"`
	IsTrashed   bool           `json:"isTrashed"`
	IsArchived  bool           `json:"isArchived"`
	IsPinned    bool           `json:"isPinned"`
}

func (kn keepNote) isEmpty() bool {
	return kn.Title == "" && kn.TextContent == "" && len(kn.ListContent) == 0
}

func keepColorToHex(color string) string {
	switch strings.ToUpper(color) {
	case "YELLOW":
		return "#fbbc04"
	case "GREEN", "TEAL":
		return "#34a853"
	case "BLUE", "CERULEAN":
		return "#4285f4"
	case "RED", "PINK":
		return "#ea4335"
	case "PURPLE", "GRAY", "GREY", "BROWN":
		return "#9aa0a6"
	default:
		return models.DefaultNoteColor
	}
}

func (h *NotesHandler) importKeepNote(ctx context.Context, userID string, kn keepNote) error {
	if utf8.RuneCountInString(kn.Title) > noteTitleMaxLength {
		return fmt.Errorf("title exceeds %d character limit", noteTitleMaxLength)
	}
	if utf8.RuneCountInString(kn.TextContent) > noteContentMaxLength {
		return fmt.Errorf("content exceeds %d character limit", noteContentMaxLength)
	}
	if len(kn.ListContent) > noteItemsMaxCount {
		return fmt.Errorf("note has more than %d items", noteItemsMaxCount)
	}
	for _, item := range kn.ListContent {
		if utf8.RuneCountInString(item.Text) > noteItemTextMaxLength {
			return fmt.Errorf("item text exceeds %d character limit", noteItemTextMaxLength)
		}
	}

	noteType := models.NoteTypeText
	if len(kn.ListContent) > 0 {
		noteType = models.NoteTypeTodo
	}

	color := keepColorToHex(kn.Color)

	note, err := h.noteStore.Create(ctx, userID, kn.Title, kn.TextContent, noteType, color)
	if err != nil {
		return err
	}

	if noteType == models.NoteTypeTodo {
		for i, item := range kn.ListContent {
			if _, err := h.noteStore.CreateItemWithCompleted(ctx, note.ID, item.Text, i, item.IsChecked, 0, ""); err != nil {
				return err
			}
		}
	}

	if kn.IsPinned || kn.IsArchived {
		f := false
		if err := h.noteStore.Update(ctx, note.ID, userID, nil, nil, nil, &kn.IsPinned, &kn.IsArchived, &f); err != nil {
			return err
		}
	}

	return nil
}

const (
	keepImportMaxEntrySize = 1 << 20  // 1 MB per zip entry
	keepImportMaxTotalSize = 64 << 20 // 64 MB total decompressed
)

func parseKeepNotesFromZip(zr *zip.Reader) []keepNote {
	notes := make([]keepNote, 0, len(zr.File))
	var totalRead int64
	for _, f := range zr.File {
		if !strings.HasSuffix(strings.ToLower(f.Name), ".json") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		lr := &io.LimitedReader{R: rc, N: keepImportMaxEntrySize + 1}
		jsonData, err := io.ReadAll(lr)
		_ = rc.Close()
		totalRead += int64(len(jsonData))
		if totalRead > keepImportMaxTotalSize {
			break
		}
		if err != nil || lr.N == 0 {
			continue // read error or entry exceeded per-entry limit
		}
		var kn keepNote
		if err := json.Unmarshal(jsonData, &kn); err != nil {
			continue
		}
		if kn.isEmpty() {
			continue
		}
		notes = append(notes, kn)
	}
	return notes
}

func parseKeepNotesFromData(filename string, data []byte) ([]keepNote, error) {
	isZip := strings.HasSuffix(strings.ToLower(filename), ".zip") ||
		(len(data) >= 4 && data[0] == 'P' && data[1] == 'K' && data[2] == 0x03 && data[3] == 0x04)

	if isZip {
		zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return nil, errors.New("invalid zip file")
		}
		return parseKeepNotesFromZip(zr), nil
	}

	var kn keepNote
	if err := json.Unmarshal(data, &kn); err != nil {
		return nil, errors.New("invalid JSON file")
	}
	if kn.isEmpty() {
		return nil, errors.New("note must have a title, content, or items")
	}
	return []keepNote{kn}, nil
}

func (h *NotesHandler) importKeepNotes(ctx context.Context, userID string, keepNotes []keepNote) (imported, skipped int, importErrors []string) {
	for i, kn := range keepNotes {
		if kn.IsTrashed {
			skipped++
			continue
		}
		if err := h.importKeepNote(ctx, userID, kn); err != nil {
			label := truncateRunes(kn.Title, noteTitleMaxLength)
			if label == "" {
				label = fmt.Sprintf("note #%d", i+1)
			}
			importErrors = append(importErrors, fmt.Sprintf("failed to import %q: %v", label, err))
			continue
		}
		imported++
	}
	return imported, skipped, importErrors
}

const (
	importTypeJotJSON    = "jot_json"
	importTypeGoogleKeep = "google_keep"
	jotExportFormat      = "jot_export"
	jotExportVersion     = 1
)

// --- Jot JSON import types ---

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
}

type jotImportEnvelope struct {
	Format  string          `json:"format"`
	Version int             `json:"version"`
	Notes   []jotImportNote `json:"notes"`
}

func (h *NotesHandler) importJotJSON(ctx context.Context, userID string, data []byte) (int, error) {
	var raw jotImportEnvelope
	if err := json.Unmarshal(data, &raw); err != nil {
		return 0, errors.New("invalid JSON file")
	}
	if raw.Format != jotExportFormat {
		return 0, fmt.Errorf("invalid format %q: expected jot_export", raw.Format)
	}
	if raw.Version != jotExportVersion {
		return 0, fmt.Errorf("unsupported version %d: only version 1 is supported", raw.Version)
	}
	if raw.Notes == nil {
		return 0, errors.New("notes must be a JSON array")
	}

	importNotes := make([]models.JotImportNote, 0, len(raw.Notes))
	for i, n := range raw.Notes {
		importNote, err := validateJotImportNote(i+1, n)
		if err != nil {
			return 0, err
		}
		importNotes = append(importNotes, importNote)
	}

	if err := h.noteStore.ImportJotNotes(ctx, userID, importNotes); err != nil {
		return 0, err
	}
	return len(importNotes), nil
}

// validateJotImportNote validates a single note from a Jot JSON export and converts
// it to the store import type. idx is 1-based and used only in error messages.
func validateJotImportNote(idx int, n jotImportNote) (models.JotImportNote, error) {
	if n.NoteType != models.NoteTypeText && n.NoteType != models.NoteTypeTodo {
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

	color := n.Color
	if color == "" {
		color = models.DefaultNoteColor
	}
	if err := validateColor(color); err != nil {
		return models.JotImportNote{}, fmt.Errorf("note #%d: %w", idx, err)
	}

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
//	@Summary	Import notes from a supported export format
//	@Tags		notes
//	@Security	CookieAuth
//	@Accept		multipart/form-data
//	@Produce	json
//	@Param		file			formData	file	true	"Export file to import"
//	@Param		import_type		formData	string	true	"Import format: jot_json or google_keep"
//	@Success	200				{object}	ImportResponse
//	@Failure	400				{string}	string	"bad request"
//	@Failure	401				{string}	string	"unauthorized"
//	@Failure	500				{string}	string	"internal server error"
//	@Router		/notes/import [post]
func (h *NotesHandler) ImportNotes(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		return http.StatusBadRequest, nil, errors.New("invalid multipart form")
	}

	importType := r.FormValue("import_type")
	switch importType {
	case importTypeJotJSON, importTypeGoogleKeep:
		// valid
	case "":
		return http.StatusBadRequest, nil, errors.New("missing import_type")
	default:
		return http.StatusBadRequest, nil, fmt.Errorf("unsupported import_type %q", importType)
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		return http.StatusBadRequest, nil, errors.New("missing file")
	}
	defer func() { _ = file.Close() }()

	data, err := io.ReadAll(file)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	switch importType {
	case importTypeJotJSON:
		imported, err := h.importJotJSON(r.Context(), user.ID, data)
		if err != nil {
			return http.StatusBadRequest, nil, err
		}
		return http.StatusOK, ImportResponse{Imported: imported}, nil
	default: // google_keep
		keepNotes, err := parseKeepNotesFromData(header.Filename, data)
		if err != nil {
			return http.StatusBadRequest, nil, err
		}
		imported, skipped, importErrors := h.importKeepNotes(r.Context(), user.ID, keepNotes)
		return http.StatusOK, ImportResponse{Imported: imported, Skipped: skipped, Errors: importErrors}, nil
	}
}
