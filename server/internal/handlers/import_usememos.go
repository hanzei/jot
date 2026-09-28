package handlers

import (
	"context"
	jsonv1 "encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/hanzei/jot/server/internal/models"
)

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
		if err := jsonv1.Unmarshal(body, &apiResp); err != nil {
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
// imported (false means it was skipped) and the reason when it was skipped
// because of an error.
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
	title, checklist, isChecklist := parseMemoChecklist(content)
	noteType := models.NoteTypeText
	noteTitle := ""
	noteContent := content
	var items []models.JotImportNoteItem
	if isChecklist {
		noteType = models.NoteTypeList
		noteTitle = title
		noteContent = ""
		items = make([]models.JotImportNoteItem, 0, len(checklist))
		for i, item := range checklist {
			items = append(items, models.JotImportNoteItem{
				Text:        item.text,
				Completed:   item.completed,
				Position:    i,
				IndentLevel: item.indentLevel,
			})
		}
	}

	// One transaction per memo: the note lands with all its items, labels and
	// pinned/archived state, or not at all, and a failing memo does not discard
	// the others.
	note := models.JotImportNote{
		Title:    noteTitle,
		Content:  noteContent,
		NoteType: noteType,
		Color:    models.DefaultNoteColor,
		Pinned:   memo.Pinned,
		Archived: state == usememosStateArchived,
		Labels:   normalizeLabels(tags),
		Items:    items,
	}
	if err := h.noteStore.ImportJotNotes(ctx, userID, []models.JotImportNote{note}); err != nil {
		return false, []string{fmt.Sprintf("failed to import memo #%d: %v", idx+1, err)}
	}
	return true, nil
}
