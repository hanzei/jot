package handlers

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/models"
)

type ImportResponse struct {
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Errors   []string `json:"errors,omitempty"`
}

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

func (h *NotesHandler) importKeepNote(userID string, kn keepNote) error {
	noteType := models.NoteTypeText
	if len(kn.ListContent) > 0 {
		noteType = models.NoteTypeTodo
	}

	color := keepColorToHex(kn.Color)

	note, err := h.noteStore.Create(userID, kn.Title, kn.TextContent, noteType, color)
	if err != nil {
		return err
	}

	if noteType == models.NoteTypeTodo {
		for i, item := range kn.ListContent {
			if _, err := h.noteStore.CreateItemWithCompleted(note.ID, item.Text, i, item.IsChecked, 0, nil); err != nil {
				return err
			}
		}
	}

	if kn.IsPinned || kn.IsArchived {
		f := false
		if err := h.noteStore.Update(note.ID, userID, &kn.Title, &kn.TextContent, &color, &kn.IsPinned, &kn.IsArchived, &f); err != nil {
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
	var notes []keepNote
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

func (h *NotesHandler) importKeepNotes(userID string, keepNotes []keepNote) (imported, skipped int, importErrors []string) {
	for i, kn := range keepNotes {
		if kn.IsTrashed {
			skipped++
			continue
		}
		if err := h.importKeepNote(userID, kn); err != nil {
			title := kn.Title
			if title == "" {
				title = fmt.Sprintf("note #%d", i+1)
			}
			importErrors = append(importErrors, fmt.Sprintf("failed to import %q: %v", title, err))
			continue
		}
		imported++
	}
	return imported, skipped, importErrors
}

// ImportNotes godoc
//
//	@Summary	Import notes from a Google Keep export
//	@Tags		notes
//	@Security	CookieAuth
//	@Accept		multipart/form-data
//	@Produce	json
//	@Param		file	formData	file			true	"Google Keep JSON or ZIP export file"
//	@Success	200		{object}	ImportResponse
//	@Failure	400		{string}	string	"bad request"
//	@Failure	401		{string}	string	"unauthorized"
//	@Failure	500		{string}	string	"internal server error"
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

	file, header, err := r.FormFile("file")
	if err != nil {
		return http.StatusBadRequest, nil, errors.New("missing file")
	}
	defer func() { _ = file.Close() }()

	data, err := io.ReadAll(file)
	if err != nil {
		return http.StatusInternalServerError, nil, err
	}

	keepNotes, err := parseKeepNotesFromData(header.Filename, data)
	if err != nil {
		return http.StatusBadRequest, nil, err
	}

	imported, skipped, importErrors := h.importKeepNotes(user.ID, keepNotes)

	return http.StatusOK, ImportResponse{Imported: imported, Skipped: skipped, Errors: importErrors}, nil
}
