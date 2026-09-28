package handlers

import (
	"context"
	jsonv1 "encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"unicode/utf8"

	"github.com/hanzei/jot/server/internal/apierr"
	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
)

// ImportResponse reports the outcome of an import.
//
// Jot JSON imports are all-or-nothing: the whole file is validated up front
// and written in one transaction. Google Keep and usememos imports are
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

func (h *NotesHandler) importJotJSON(ctx context.Context, userID string, data []byte) (int, int, error) {
	var raw jotImportEnvelope
	if err := jsonv1.Unmarshal(data, &raw); err != nil {
		return 0, http.StatusBadRequest, apierr.New(apierr.CodeInvalidImportFile, "invalid JSON file")
	}
	if raw.Format != jotExportFormat {
		return 0, http.StatusBadRequest, apierr.WithCode(apierr.CodeInvalidImportFile, fmt.Errorf("invalid format %q: expected jot_export", raw.Format))
	}
	if raw.Version != jotExportVersion {
		return 0, http.StatusBadRequest, apierr.WithCode(apierr.CodeInvalidImportFile, fmt.Errorf("unsupported version %d: only version 1 is supported", raw.Version))
	}
	if raw.Notes == nil {
		return 0, http.StatusBadRequest, apierr.New(apierr.CodeInvalidImportFile, "notes must be a JSON array")
	}

	importNotes := make([]models.JotImportNote, 0, len(raw.Notes))
	for i, n := range raw.Notes {
		importNote, err := validateJotImportNote(i+1, n)
		if err != nil {
			return 0, http.StatusBadRequest, err
		}
		importNotes = append(importNotes, importNote)
	}

	if err := h.noteStore.ImportJotNotes(ctx, userID, importNotes); err != nil {
		return 0, http.StatusInternalServerError, fmt.Errorf("import jot notes: %w", err)
	}
	return len(importNotes), http.StatusOK, nil
}

// validateJotImportNote validates a single note from a Jot JSON export and converts
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
//	@Summary	Import notes from a supported export format
//	@Tags		notes
//	@Security	CookieAuth
//	@Accept		multipart/form-data
//	@Produce	json
//	@Param		import_type	formData	string	true	"Import format: jot_json or google_keep (requires file); usememos (requires url and token)"
//	@Param		file		formData	file	false	"Export file (required when import_type is jot_json or google_keep)"
//	@Param		url			formData	string	false	"Memos instance URL (required when import_type is usememos)"
//	@Param		token		formData	string	false	"Memos API token (required when import_type is usememos)"
//	@Success	200			{object}	ImportResponse
//	@Failure	400			{object}	apierr.ErrorResponse	"bad request, or not a readable export (invalid_import_file)"
//	@Failure	401			{object}	apierr.ErrorResponse	"unauthorized"
//	@Failure	413			{object}	apierr.ErrorResponse	"request body too large"
//	@Failure	500			{object}	apierr.ErrorResponse	"internal server error"
//	@Router		/notes/import [post]
func (h *NotesHandler) ImportNotes(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
	//nolint:gosec // r.Body is already bounded by the MaxBytesReader above
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
			return http.StatusRequestEntityTooLarge, nil, err
		}
		return http.StatusBadRequest, nil, errors.New("invalid multipart form")
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

	data, err := io.ReadAll(file)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	switch importType {
	case importTypeJotJSON:
		imported, status, err := h.importJotJSON(r.Context(), user.ID, data)
		if err != nil {
			return status, nil, err
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
