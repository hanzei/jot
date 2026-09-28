package handlers

import (
	"archive/zip"
	"bytes"
	"context"
	jsonv1 "encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/hanzei/jot/server/internal/models"
)

// --- Google Keep import types ---

type keepNoteItem struct {
	Text      string `json:"text"`
	IsChecked bool   `json:"isChecked"`
}

type keepNoteLabel struct {
	Name string `json:"name"`
}

type keepNote struct {
	Title       string          `json:"title"`
	TextContent string          `json:"textContent"`
	ListContent []keepNoteItem  `json:"listContent"`
	Labels      []keepNoteLabel `json:"labels"`
	Color       string          `json:"color"`
	IsTrashed   bool            `json:"isTrashed"`
	IsArchived  bool            `json:"isArchived"`
	IsPinned    bool            `json:"isPinned"`
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

// keepNoteFields returns the title and content to store for a Google Keep note.
// List notes preserve the Keep title as the note title with no content.
// Text notes have no title; the Keep title is rendered as a Markdown H1 heading
// prepended to the textContent (e.g. "# My Keep Title\n\nbody text"). When there
// is no textContent the heading alone becomes the content; when there is no title
// the textContent is used as-is.
func keepNoteFields(title, textContent string, noteType models.NoteType) (string, string) {
	if noteType == models.NoteTypeList {
		return title, ""
	}
	switch {
	case title == "":
		return "", textContent
	case textContent == "":
		return "", "# " + title
	default:
		return "", "# " + title + "\n\n" + textContent
	}
}

// keepNoteToImport validates a Google Keep note and maps it to the store import
// type. Keep list items are flat in the Takeout export, so every item is
// top-level.
func keepNoteToImport(kn keepNote) (models.JotImportNote, error) {
	if utf8.RuneCountInString(kn.Title) > noteTitleMaxLength {
		return models.JotImportNote{}, fmt.Errorf("title exceeds %d character limit", noteTitleMaxLength)
	}
	if utf8.RuneCountInString(kn.TextContent) > noteContentMaxLength {
		return models.JotImportNote{}, fmt.Errorf("content exceeds %d character limit", noteContentMaxLength)
	}
	if len(kn.ListContent) > noteItemsMaxCount {
		return models.JotImportNote{}, fmt.Errorf("note has more than %d items", noteItemsMaxCount)
	}
	for _, item := range kn.ListContent {
		if utf8.RuneCountInString(item.Text) > noteItemTextMaxLength {
			return models.JotImportNote{}, fmt.Errorf("item text exceeds %d character limit", noteItemTextMaxLength)
		}
	}

	noteType := models.NoteTypeText
	if len(kn.ListContent) > 0 {
		noteType = models.NoteTypeList
	}

	// For list notes, title is preserved; textContent is ignored (list notes have
	// no content field). For text notes, textContent is used as content; if
	// textContent is empty, the Keep title is used as a fallback so title-only
	// Keep notes are not silently imported as empty.
	title, content := keepNoteFields(kn.Title, kn.TextContent, noteType)

	var items []models.JotImportNoteItem
	if noteType == models.NoteTypeList {
		items = make([]models.JotImportNoteItem, 0, len(kn.ListContent))
		for i, item := range kn.ListContent {
			items = append(items, models.JotImportNoteItem{Text: item.Text, Completed: item.IsChecked, Position: i})
		}
	}

	labelNames := make([]string, 0, len(kn.Labels))
	for _, l := range kn.Labels {
		labelNames = append(labelNames, l.Name)
	}

	return models.JotImportNote{
		Title:    title,
		Content:  content,
		NoteType: noteType,
		Color:    keepColorToHex(kn.Color),
		Pinned:   kn.IsPinned,
		Archived: kn.IsArchived,
		Labels:   normalizeLabels(labelNames),
		Items:    items,
	}, nil
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
		if err := jsonv1.Unmarshal(jsonData, &kn); err != nil {
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
	if err := jsonv1.Unmarshal(data, &kn); err != nil {
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
		note, err := keepNoteToImport(kn)
		if err == nil {
			// One transaction per note: the note lands complete or not at all,
			// and a failing note does not discard the others.
			err = h.noteStore.ImportJotNotes(ctx, userID, []models.JotImportNote{note})
		}
		if err != nil {
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
