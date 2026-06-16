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
	"net/url"
	"regexp"
	"strings"
	"time"
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
		noteType = models.NoteTypeList
	}

	color := keepColorToHex(kn.Color)

	// For list notes, title is preserved; textContent is ignored (list notes have
	// no content field). For text notes, textContent is used as content; if
	// textContent is empty, the Keep title is used as a fallback so title-only
	// Keep notes are not silently imported as empty.
	title, content := keepNoteFields(kn.Title, kn.TextContent, noteType)

	note, err := h.noteStore.Create(ctx, userID, "", title, content, noteType, color)
	if err != nil {
		return err
	}

	if noteType == models.NoteTypeList {
		// Google Keep list items are flat (no nesting), so every item is top-level.
		for i, item := range kn.ListContent {
			if _, err := h.noteStore.CreateItemWithCompleted(ctx, note.ID, item.Text, i, item.IsChecked, "", ""); err != nil {
				return err
			}
		}
	}

	if kn.IsPinned || kn.IsArchived {
		f := false
		if err := h.noteStore.Update(ctx, note.ID, userID, nil, nil, nil, &kn.IsPinned, &kn.IsArchived, &f, nil); err != nil {
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
	if err := json.Unmarshal(data, &raw); err != nil {
		return 0, http.StatusBadRequest, errors.New("invalid JSON file")
	}
	if raw.Format != jotExportFormat {
		return 0, http.StatusBadRequest, fmt.Errorf("invalid format %q: expected jot_export", raw.Format)
	}
	if raw.Version != jotExportVersion {
		return 0, http.StatusBadRequest, fmt.Errorf("unsupported version %d: only version 1 is supported", raw.Version)
	}
	if raw.Notes == nil {
		return 0, http.StatusBadRequest, errors.New("notes must be a JSON array")
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
	if n.NoteType != models.NoteTypeText && n.NoteType != models.NoteTypeList {
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
//	@Param		import_type		formData	string	true	"Import format: jot_json or google_keep (requires file); usememos (requires url and token)"
//	@Param		file			formData	file	false	"Export file (required when import_type is jot_json or google_keep)"
//	@Param		url				formData	string	false	"Memos instance URL (required when import_type is usememos)"
//	@Param		token			formData	string	false	"Memos API token (required when import_type is usememos)"
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

// --- usememos import ---

const (
	usememosMaxPages       = 100
	usememosPageSize       = 100
	usememosRequestTimeout = 30 * time.Second
)

// usememosHTTPClient is shared across import calls so TCP connections are pooled
// across the paginated requests of a single import session.
var usememosHTTPClient = &http.Client{
	Transport: &http.Transport{
		ResponseHeaderTimeout: 15 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
	},
}

type usememosAPIMemo struct {
	Name      string   `json:"name"`
	State     string   `json:"state"`     // "NORMAL" or "ARCHIVED" (v1 API). Some servers also report "DELETED".
	RowStatus string   `json:"rowStatus"` // "NORMAL", "ARCHIVED" (older API)
	Content   string   `json:"content"`
	Tags      []string `json:"tags"`
	Pinned    bool     `json:"pinned"`
}

// The Memos v1 API State enum (proto/api/v1/common.proto) defines:
//
//	STATE_UNSPECIFIED, NORMAL, ARCHIVED
//
// There is no "ACTIVE" value — the active/non-archived state is named NORMAL.
// usememosStateDeleted is not part of the v1 enum but is kept for older API
// versions whose row_status field may report a deleted state.
const (
	usememosStateNormal   = "NORMAL"
	usememosStateArchived = "ARCHIVED"
	usememosStateDeleted  = "DELETED"
)

// normalizedState returns a canonical state string regardless of API version.
func (m usememosAPIMemo) normalizedState() string {
	if m.State != "" {
		return m.State
	}
	switch m.RowStatus {
	case usememosStateArchived:
		return usememosStateArchived
	case "NORMAL", "":
		return usememosStateNormal
	default:
		return usememosStateDeleted
	}
}

type usememosAPIResponse struct {
	Memos         []usememosAPIMemo `json:"memos"` // v1 API
	Data          []usememosAPIMemo `json:"data"`  // older API
	NextPageToken string            `json:"nextPageToken"`
}

func (r usememosAPIResponse) memos() []usememosAPIMemo {
	if len(r.Memos) > 0 {
		return r.Memos
	}
	return r.Data
}

var (
	// inlineCodeRE matches backtick-delimited inline code spans.
	inlineCodeRE = regexp.MustCompile("`[^`\n]+`")
	// hashTagRE matches a #hashtag preceded by start-of-string or a space/tab.
	// The tag must start with a letter and continue with word characters.
	hashTagRE = regexp.MustCompile(`(?:^|[ \t])#([a-zA-Z]\w*)`)
)

// extractAndStripTags removes standalone #hashtag tokens from content,
// skipping fenced code blocks and inline code spans. It returns the cleaned
// content and a deduplicated, ordered list of tag names (without the # prefix).
func extractAndStripTags(content string) (string, []string) {
	seen := map[string]struct{}{}
	var tags []string

	lines := strings.Split(content, "\n")
	inFence := false
	var fenceMarker string
	resultLines := make([]string, 0, len(lines))

	for _, line := range lines {
		trimmed := strings.TrimLeft(line, " \t")
		if isFenceMarker(trimmed) {
			if !inFence {
				inFence = true
				fenceMarker = trimmed[:3]
			} else if strings.HasPrefix(trimmed, fenceMarker) {
				inFence = false
			}
			resultLines = append(resultLines, line)
			continue
		}
		if inFence {
			resultLines = append(resultLines, line)
			continue
		}
		resultLines = append(resultLines, stripTagsFromLine(line, seen, &tags))
	}

	return strings.TrimSpace(strings.Join(resultLines, "\n")), tags
}

func isFenceMarker(trimmed string) bool {
	return strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~")
}

// stripTagsFromLine extracts and strips #hashtag tokens from a single non-fenced
// line. Hashtags inside inline code spans are left untouched.
func stripTagsFromLine(line string, seen map[string]struct{}, tags *[]string) string {
	// Mask inline code spans with NUL bytes (length-preserving) so the tag
	// regex cannot match hashtags inside them.
	masked := inlineCodeRE.ReplaceAllStringFunc(line, func(s string) string {
		return strings.Repeat("\x00", len(s))
	})

	// FindAllStringSubmatchIndex returns [fullStart, fullEnd, group1Start, group1End] per match,
	// so we collect tag names and full-match bounds in a single pass.
	all := hashTagRE.FindAllStringSubmatchIndex(masked, -1)
	if len(all) == 0 {
		return line
	}

	matchIdxs := make([][]int, len(all))
	for i, m := range all {
		tag := masked[m[2]:m[3]]
		if _, dup := seen[tag]; !dup {
			seen[tag] = struct{}{}
			*tags = append(*tags, tag)
		}
		matchIdxs[i] = m[:2]
	}

	return rebuildLineWithoutTags(line, masked, matchIdxs)
}

// rebuildLineWithoutTags reconstructs line with the tag tokens removed.
// NUL bytes in masked mark inline code spans whose original bytes are taken from line.
// Leading whitespace before each tag is preserved; the tag itself is dropped.
func rebuildLineWithoutTags(line, masked string, matchIdxs [][]int) string {
	var buf strings.Builder
	buf.Grow(len(line))
	pos := 0
	for _, idx := range matchIdxs {
		matchStart, matchEnd := idx[0], idx[1]
		writeOriginal(&buf, line, masked, pos, matchStart)
		// Preserve a leading space/tab before the '#' but drop the tag itself.
		if matchStart < len(masked) && masked[matchStart] != '#' {
			buf.WriteByte(line[matchStart])
		}
		pos = matchEnd
	}
	writeOriginal(&buf, line, masked, pos, len(line))
	return strings.TrimRight(buf.String(), " \t")
}

// writeOriginal writes bytes from line[start:end], using line for NUL positions
// (which correspond to inline code spans) and masked elsewhere.
func writeOriginal(buf *strings.Builder, line, masked string, start, end int) {
	for i := start; i < end; i++ {
		if masked[i] == '\x00' {
			buf.WriteByte(line[i])
		} else {
			buf.WriteByte(masked[i])
		}
	}
}

// mergeTagLists merges existing and additional tags into a single list,
// trimming whitespace, skipping empties, and deduplicating case-insensitively
// (preserving the case of the first occurrence). The Memos API returns tags as
// a separate `tags` field; merging them with hashtags extracted from content
// ensures tags managed via the Memos UI (not inline) are imported.
func mergeTagLists(existing, additional []string) []string {
	seen := make(map[string]struct{}, len(existing)+len(additional))
	out := make([]string, 0, len(existing)+len(additional))
	add := func(tags []string) {
		for _, t := range tags {
			trimmed := strings.TrimSpace(t)
			if trimmed == "" {
				continue
			}
			key := strings.ToLower(trimmed)
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, trimmed)
		}
	}
	add(existing)
	add(additional)
	return out
}

// fetchUsememosMemos pages through the usememos v1 API and returns all memos
// across both NORMAL and ARCHIVED states. The v1 API defaults to returning only
// NORMAL memos, so archived memos require a second pass with state=ARCHIVED.
// Returns the combined memo list and a boolean that is true when the page-cap
// was hit before all results were fetched.
func fetchUsememosMemos(ctx context.Context, baseURL, token string) ([]usememosAPIMemo, bool, error) {
	active, activeCapped, err := fetchUsememosMemosForState(ctx, baseURL, token, usememosStateNormal)
	if err != nil {
		return nil, false, err
	}
	archived, archivedCapped, err := fetchUsememosMemosForState(ctx, baseURL, token, usememosStateArchived)
	if err != nil {
		return nil, false, err
	}
	return append(active, archived...), activeCapped || archivedCapped, nil
}

// fetchUsememosMemosForState pages through memos in a single state. Returns the
// fetched memos and a boolean indicating whether the page-cap was hit before
// the API stopped paginating (i.e., the result is incomplete).
func fetchUsememosMemosForState(ctx context.Context, baseURL, token, state string) ([]usememosAPIMemo, bool, error) {
	base := strings.TrimRight(baseURL, "/")
	var all []usememosAPIMemo
	pageToken := ""

	for pageNum := range usememosMaxPages {
		apiURL := fmt.Sprintf("%s/api/v1/memos?pageSize=%d&state=%s", base, usememosPageSize, state)
		if pageToken != "" {
			apiURL += "&pageToken=" + url.QueryEscape(pageToken)
		}

		pageCtx, cancel := context.WithTimeout(ctx, usememosRequestTimeout)
		req, err := http.NewRequestWithContext(pageCtx, http.MethodGet, apiURL, nil) //nolint:gosec // URL is validated to be http/https in the handler before this function is called
		if err != nil {
			cancel()
			return nil, false, fmt.Errorf("build request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+token)

		resp, err := usememosHTTPClient.Do(req) //nolint:gosec // same as above
		if err != nil {
			cancel()
			return nil, false, fmt.Errorf("fetch memos (page %d): %w", pageNum+1, err)
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
		_ = resp.Body.Close()
		cancel() // cancel after body is fully read so the context stays live during streaming
		if readErr != nil {
			return nil, false, fmt.Errorf("read response (page %d): %w", pageNum+1, readErr)
		}
		if resp.StatusCode != http.StatusOK {
			return nil, false, fmt.Errorf("usememos returned status %d — check your URL and token", resp.StatusCode)
		}

		var apiResp usememosAPIResponse
		if err := json.Unmarshal(body, &apiResp); err != nil {
			return nil, false, fmt.Errorf("parse response: %w", err)
		}
		all = append(all, apiResp.memos()...)

		if apiResp.NextPageToken == "" {
			return all, false, nil
		}
		pageToken = apiResp.NextPageToken
	}
	// Loop exhausted its page budget while the server still had more pages.
	return all, true, nil
}

// importMemosFromUsememos fetches all memos from the given usememos instance
// and imports them into Jot. NORMAL and ARCHIVED memos are imported (preserving
// pinned and archived state); DELETED memos are skipped. Inline #hashtags are
// extracted as Jot labels and stripped from the note content.
func (h *NotesHandler) importMemosFromUsememos(ctx context.Context, userID, baseURL, token string) (imported, skipped int, importErrors []string) {
	memos, capped, err := fetchUsememosMemos(ctx, baseURL, token)
	if err != nil {
		return 0, 0, []string{err.Error()}
	}
	if capped {
		importErrors = append(importErrors, fmt.Sprintf("import was capped at %d memos per state; some memos were not imported", usememosMaxPages*usememosPageSize))
	}

	for i, memo := range memos {
		didImport, memoErrs := h.importSingleMemo(ctx, userID, i, memo)
		importErrors = append(importErrors, memoErrs...)
		if didImport {
			imported++
		} else {
			skipped++
		}
	}
	return imported, skipped, importErrors
}

// memoChecklistItem is a single Markdown task-list item parsed from a memo body.
type memoChecklistItem struct {
	text        string
	completed   bool
	indentLevel int
}

// memoTaskItemRE matches a single Markdown task-list item, e.g. "- [ ] foo" or
// "  * [x] bar". Group 1 is the leading indentation, group 2 is the checkbox
// state (" ", "x", or "X"), and group 3 is the item text.
var memoTaskItemRE = regexp.MustCompile(`^([ \t]*)[-*+] \[([ xX])\][ \t]*(.*)$`)

// memoHeadingRE matches an ATX Markdown heading line (e.g. "# Groceries"),
// capturing the heading text. Used to derive a list note's title from a memo
// whose first line is a heading.
var memoHeadingRE = regexp.MustCompile(`^#{1,6}[ \t]+(.+?)[ \t]*$`)

// parseMemoChecklist detects a memo body that should become a Jot list note. A
// body qualifies when every non-empty line is a Markdown task-list item ("- [ ]"
// / "- [x]"), optionally preceded by a single ATX heading line that becomes the
// note title. The boolean is false when the body is not such a checklist or when
// it exceeds Jot's list-note limits, in which case the caller imports the memo
// as a text note instead so no content is lost. Indentation maps to a single
// indent level (Jot supports 0–1).
func parseMemoChecklist(content string) (title string, items []memoChecklistItem, ok bool) {
	lines := strings.Split(content, "\n")

	// An optional heading on the first non-empty line becomes the note title.
	start := 0
	for start < len(lines) && strings.TrimSpace(lines[start]) == "" {
		start++
	}
	if start < len(lines) {
		if m := memoHeadingRE.FindStringSubmatch(lines[start]); m != nil {
			title = m[1]
			start++
		}
	}
	if utf8.RuneCountInString(title) > noteTitleMaxLength {
		return "", nil, false
	}

	items = make([]memoChecklistItem, 0, len(lines)-start)
	for _, line := range lines[start:] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		m := memoTaskItemRE.FindStringSubmatch(line)
		if m == nil {
			return "", nil, false
		}
		text := strings.TrimRight(m[3], " \t")
		if utf8.RuneCountInString(text) > noteItemTextMaxLength {
			return "", nil, false
		}
		indentLevel := 0
		if len(m[1]) > 0 {
			indentLevel = 1
		}
		items = append(items, memoChecklistItem{
			text:        text,
			completed:   m[2] == "x" || m[2] == "X",
			indentLevel: indentLevel,
		})
	}
	if len(items) == 0 || len(items) > noteItemsMaxCount {
		return "", nil, false
	}
	return title, items, true
}

// importSingleMemo imports a single memo, returning whether it was actually
// imported (false means it was skipped) and any non-fatal errors that occurred.
func (h *NotesHandler) importSingleMemo(ctx context.Context, userID string, idx int, memo usememosAPIMemo) (bool, []string) {
	state := memo.normalizedState()
	if state == usememosStateDeleted {
		return false, nil
	}
	if utf8.RuneCountInString(memo.Content) > noteContentMaxLength {
		return false, []string{fmt.Sprintf("skipped memo #%d: content exceeds %d character limit", idx+1, noteContentMaxLength)}
	}

	content, tags := extractAndStripTags(memo.Content)
	tags = mergeTagLists(tags, memo.Tags)
	if content == "" && len(tags) == 0 {
		return false, nil
	}

	// A memo whose body is entirely a Markdown checklist (optionally preceded by
	// a heading that becomes the title) becomes a Jot list note so the items stay
	// individually checkable; anything else is a text note that preserves the raw
	// Markdown content.
	title, items, isChecklist := parseMemoChecklist(content)
	noteType := models.NoteTypeText
	noteTitle := ""
	noteContent := content
	if isChecklist {
		noteType = models.NoteTypeList
		noteTitle = title
		noteContent = ""
	}

	note, err := h.noteStore.Create(ctx, userID, "", noteTitle, noteContent, noteType, models.DefaultNoteColor)
	if err != nil {
		return false, []string{fmt.Sprintf("failed to import memo #%d: %v", idx+1, err)}
	}

	var errs []string
	if isChecklist {
		errs = append(errs, h.createMemoChecklistItems(ctx, note.ID, idx, items)...)
	}

	if len(tags) > 0 {
		if _, labelErr := h.createNoteLabels(ctx, note.ID, userID, tags); labelErr != nil {
			errs = append(errs, fmt.Sprintf("memo #%d: failed to create labels: %v", idx+1, labelErr))
		}
	}

	archived := state == usememosStateArchived
	if memo.Pinned || archived {
		f := false
		if err := h.noteStore.Update(ctx, note.ID, userID, nil, nil, nil, &memo.Pinned, &archived, &f, nil); err != nil {
			errs = append(errs, fmt.Sprintf("memo #%d: failed to set pinned/archived: %v", idx+1, err))
		}
	}
	return true, errs
}

// createMemoChecklistItems creates the parsed checklist items for an imported
// memo, converting parsed indent levels into parent references: each indented
// item attaches to the most recent top-level item. It returns one error string
// per item that failed to create.
func (h *NotesHandler) createMemoChecklistItems(ctx context.Context, noteID string, idx int, items []memoChecklistItem) []string {
	var errs []string
	var lastTopLevelID string
	for i, item := range items {
		parentID := ""
		if item.indentLevel == 1 {
			parentID = lastTopLevelID
		}
		created, err := h.noteStore.CreateItemWithCompleted(ctx, noteID, item.text, i, item.completed, parentID, "")
		if err != nil {
			errs = append(errs, fmt.Sprintf("memo #%d: failed to create list item: %v", idx+1, err))
			continue
		}
		if item.indentLevel == 0 {
			lastTopLevelID = created.ID
		}
	}
	return errs
}
