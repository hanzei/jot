package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/hanzei/jot/server/internal/auth"
	"github.com/hanzei/jot/server/internal/logutil"
	"github.com/hanzei/jot/server/internal/models"
)

type jotExportNoteItem struct {
	Text        string `json:"text"`
	Completed   bool   `json:"completed"`
	Position    int    `json:"position"`
	IndentLevel int    `json:"indent_level"`
}

type jotExportNote struct {
	Title                 string              `json:"title"`
	Content               string              `json:"content"`
	NoteType              models.NoteType     `json:"note_type"`
	Color                 string              `json:"color"`
	Pinned                bool                `json:"pinned"`
	Archived              bool                `json:"archived"`
	Position              int                 `json:"position"`
	UnpinnedPosition      *int                `json:"unpinned_position,omitempty"`
	CheckedItemsCollapsed bool                `json:"checked_items_collapsed,omitempty"`
	Labels                []string            `json:"labels"`
	Items                 []jotExportNoteItem `json:"items,omitempty"`
}

type jotExportEnvelope struct {
	Format     string          `json:"format"`
	Version    int             `json:"version"`
	ExportedAt time.Time       `json:"exported_at"`
	Notes      []jotExportNote `json:"notes"`
}

// ExportNotes godoc
//
//	@Summary	Export notes as a Jot JSON backup
//	@Tags		notes
//	@Security	CookieAuth
//	@Produce	json
//	@Success	200	"Jot JSON export file attachment"
//	@Failure	401	{string}	string	"unauthorized"
//	@Failure	500	{string}	string	"internal server error"
//	@Router		/notes/export [get]
func (h *NotesHandler) ExportNotes(w http.ResponseWriter, r *http.Request) (int, any, error) {
	user, ok := auth.GetUserFromContext(r.Context())
	if !ok {
		return http.StatusUnauthorized, nil, errors.New("unauthorized")
	}

	notes, err := h.noteStore.GetOwnedNotesForExport(r.Context(), user.ID)
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("export notes: %w", err)
	}

	now := time.Now().UTC()

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
		}
		// Populate only the fields that belong to this note type so that
		// re-importing the export does not carry mismatched data.
		switch n.NoteType {
		case models.NoteTypeList:
			exportNote.Title = n.Title
			exportNote.CheckedItemsCollapsed = n.CheckedItemsCollapsed
			exportNote.Items = make([]jotExportNoteItem, 0, len(n.Items))
			for _, item := range n.Items {
				exportNote.Items = append(exportNote.Items, jotExportNoteItem{
					Text:        item.Text,
					Completed:   item.Completed,
					Position:    item.Position,
					IndentLevel: item.IndentLevel,
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

	export := jotExportEnvelope{
		Format:     jotExportFormat,
		Version:    jotExportVersion,
		ExportedAt: now,
		Notes:      exportNotes,
	}

	filename := "jot-export-" + now.Format("2006-01-02T15-04-05Z") + ".json"
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.WriteHeader(http.StatusOK)

	if err := json.NewEncoder(w).Encode(export); err != nil {
		logutil.FromContext(r.Context()).WithError(err).Error("Failed to encode export")
	}

	return 0, nil, nil
}
