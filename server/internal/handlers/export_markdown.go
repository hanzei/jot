package handlers

import (
	"archive/zip"
	"cmp"
	"context"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/hanzei/jot/server/internal/models"
)

// A Markdown export is a zip of plain Markdown files that opens as an
// Obsidian vault: one markdownNoteDir/<slug>.md per note, and the images in
// the same shared jotBundleImageDir the Jot bundle uses, which the notes link
// relative to themselves. Unlike the Jot bundle it is not meant to be
// imported back; it exists so a user's notes are readable without Jot.
const (
	markdownNoteDir = "notes/"

	// markdownSlugMaxRunes caps a note's filename (before any collision
	// suffix and the .md extension), well inside every filesystem's limit.
	markdownSlugMaxRunes = 60

	markdownUntitledSlug = "untitled"
)

// markdownHeadingRE is a leading ATX heading marker, mirroring HEADING_RE in
// shared/src/noteConversion.ts.
var markdownHeadingRE = regexp.MustCompile(`^#{1,6}\s+`)

// writeMarkdownBundle writes the Markdown export zip to w: each distinct
// image once, then one Markdown file per note.
func (h *NotesHandler) writeMarkdownBundle(ctx context.Context, w io.Writer, notes []*models.Note, now time.Time) error {
	zw := zip.NewWriter(w)

	images, err := h.writeBundleImages(ctx, zw, notes, now)
	if err != nil {
		return fmt.Errorf("write images: %w", err)
	}

	slugs := newMarkdownSlugs()
	for i, n := range notes {
		name := markdownNoteDir + slugs.unique(markdownNoteSlug(n)) + ".md"
		fw, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: n.UpdatedAt})
		if err != nil {
			return fmt.Errorf("create note entry: %w", err)
		}
		if _, err := io.WriteString(fw, markdownNoteFile(n, images[i])); err != nil {
			return fmt.Errorf("write note entry: %w", err)
		}
	}
	if err := zw.Close(); err != nil {
		return fmt.Errorf("close zip: %w", err)
	}
	return nil
}

// markdownNoteFile renders one note as a Markdown file: YAML front-matter,
// the body, then a link to each of its images.
func markdownNoteFile(n *models.Note, images []jotExportImage) string {
	var b strings.Builder

	b.WriteString("---\n")
	tags := markdownTags(n.Labels)
	if len(tags) == 0 {
		b.WriteString("tags: []\n")
	} else {
		b.WriteString("tags:\n")
		for _, tag := range tags {
			b.WriteString("  - " + yamlString(tag) + "\n")
		}
	}
	b.WriteString("color: " + yamlString(n.Color) + "\n")
	b.WriteString("pinned: " + strconv.FormatBool(n.Pinned) + "\n")
	b.WriteString("archived: " + strconv.FormatBool(n.Archived) + "\n")
	b.WriteString("jot_type: " + yamlString(string(n.NoteType)) + "\n")
	b.WriteString("created: " + n.CreatedAt.UTC().Format(time.RFC3339) + "\n")
	b.WriteString("updated: " + n.UpdatedAt.UTC().Format(time.RFC3339) + "\n")
	b.WriteString("---\n")

	var body string
	if n.NoteType == models.NoteTypeList {
		body = listToMarkdown(n.Title, n.Items)
	} else {
		// Text-note content is already Markdown.
		body = n.Content
	}
	if strings.TrimSpace(body) != "" {
		b.WriteString("\n" + strings.TrimRight(body, "\n") + "\n")
	}

	if len(images) > 0 {
		b.WriteString("\n")
		for _, img := range images {
			// The note sits one folder down from the shared image folder.
			b.WriteString("![" + markdownAltEscaper.Replace(img.Filename) + "](../" + img.File + ")\n")
		}
	}
	return b.String()
}

// listToMarkdown renders a list note as Markdown: the title (if any) as an h1
// line, then a task list with children indented one level under their
// parent. It is the Go twin of listToText in shared/src/noteConversion.ts —
// see that function for why item text is emitted verbatim — and both are
// pinned to shared/src/listToMarkdownCases.json, so change them together.
func listToMarkdown(title string, items []models.NoteItem) string {
	var lines []string
	if trimmed := strings.TrimSpace(title); trimmed != "" {
		lines = append(lines, "# "+trimmed, "")
	}

	// A child whose parent is not a top-level item here is dropped, as in
	// listToText.
	topLevel, children := groupListItems(items)
	for _, parent := range topLevel {
		lines = append(lines, markdownItemLine(parent, 0))
		for _, child := range children[parent.ID] {
			lines = append(lines, markdownItemLine(child, 1))
		}
	}
	return strings.Join(lines, "\n")
}

// groupListItems splits items into the top-level ones and the children of
// each (by parent ID), every group in position order.
func groupListItems(items []models.NoteItem) (topLevel []models.NoteItem, children map[string][]models.NoteItem) {
	children = make(map[string][]models.NoteItem)
	for _, item := range items {
		if item.ParentID == nil {
			topLevel = append(topLevel, item)
		} else {
			children[*item.ParentID] = append(children[*item.ParentID], item)
		}
	}
	byPosition := func(a, b models.NoteItem) int { return cmp.Compare(a.Position, b.Position) }
	slices.SortStableFunc(topLevel, byPosition)
	for _, kids := range children {
		slices.SortStableFunc(kids, byPosition)
	}
	return topLevel, children
}

func markdownItemLine(item models.NoteItem, depth int) string {
	box := "[ ]"
	if item.Completed {
		box = "[x]"
	}
	return strings.Repeat("  ", depth) + "- " + box + " " + item.Text
}

// markdownTags turns label names into Obsidian tags. Labels that end up
// equal are written once; Obsidian compares tags case-insensitively, so the
// comparison here does too.
func markdownTags(labels []models.Label) []string {
	tags := make([]string, 0, len(labels))
	for _, l := range labels {
		tag := markdownTag(l.Name)
		if tag != "" && !slices.ContainsFunc(tags, func(t string) bool { return strings.EqualFold(t, tag) }) {
			tags = append(tags, tag)
		}
	}
	return tags
}

// markdownTag keeps the characters an Obsidian tag may hold (letters, digits,
// marks, symbols such as emoji, `_`, `-` and `/`) and joins the runs between
// them with single hyphens, so whitespace or punctuation in a label does not
// cut the tag short or make Obsidian ignore it.
func markdownTag(name string) string {
	return hyphenateRuns(strings.TrimLeft(name, "#"), func(r rune) bool {
		return unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r) || unicode.Is(unicode.So, r) ||
			r == '_' || r == '-' || r == '/'
	})
}

// hyphenateRuns keeps the runes of s that keep accepts and replaces each run
// of the others between them with a single hyphen; leading and trailing runs
// are dropped.
func hyphenateRuns(s string, keep func(rune) bool) string {
	var b strings.Builder
	pendingHyphen := false
	for _, r := range s {
		if !keep(r) {
			pendingHyphen = b.Len() > 0
			continue
		}
		if pendingHyphen {
			b.WriteByte('-')
			pendingHyphen = false
		}
		b.WriteRune(r)
	}
	return b.String()
}

// yamlString quotes s as a YAML double-quoted scalar. Every escape
// strconv.Quote emits (\n, \t, \x.., \u...., ...) is valid YAML, so any value
// round-trips, whatever it holds.
func yamlString(s string) string {
	return strconv.Quote(s)
}

// markdownAltEscaper escapes what would end an image's alt text early.
var markdownAltEscaper = strings.NewReplacer(`\`, `\\`, `[`, `\[`, `]`, `\]`, "\n", " ", "\r", " ")

// markdownNoteSlug is the filename a note is exported under, before
// collisions are resolved. A list note is named after its title, a text note
// (which has no title) after its first non-blank line with any heading
// marker removed; either falls back to its first item or "untitled".
func markdownNoteSlug(n *models.Note) string {
	var candidates []string
	if n.NoteType == models.NoteTypeList {
		candidates = append(candidates, n.Title)
		if topLevel, _ := groupListItems(n.Items); len(topLevel) > 0 {
			candidates = append(candidates, topLevel[0].Text)
		}
	} else {
		for line := range strings.Lines(n.Content) {
			if line = strings.TrimSpace(line); line != "" {
				candidates = append(candidates, markdownHeadingRE.ReplaceAllString(line, ""))
				break
			}
		}
	}
	for _, c := range candidates {
		if slug := markdownSlug(c); slug != "" {
			return slug
		}
	}
	return markdownUntitledSlug
}

// markdownSlug lower-cases s and keeps only its letters and digits, joining
// the runs between them with single hyphens, capped at markdownSlugMaxRunes.
// That leaves nothing Windows, macOS or Linux rejects in a filename (no `:`,
// `?`, `/`, trailing dot or space); Windows' reserved device names are
// handled by markdownSlugs.
func markdownSlug(s string) string {
	slug := hyphenateRuns(strings.ToLower(s), func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) })
	return strings.TrimRight(truncateRunes(slug, markdownSlugMaxRunes), "-")
}

// windowsReservedNames are device names Windows refuses as a file's base
// name, whatever its extension (CON.md included).
var windowsReservedNames = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com0": true, "com1": true, "com2": true, "com3": true, "com4": true,
	"com5": true, "com6": true, "com7": true, "com8": true, "com9": true,
	"lpt0": true, "lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true,
	"lpt5": true, "lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

// markdownSlugs hands out the filenames of one export, keeping them unique.
type markdownSlugs struct {
	used map[string]bool
	// next is the suffix to try first for a base slug, so thousands of
	// "untitled" notes do not each re-probe -2, -3, ... from the start.
	next map[string]int
}

func newMarkdownSlugs() *markdownSlugs {
	return &markdownSlugs{used: make(map[string]bool), next: make(map[string]int)}
}

// unique returns slug, or slug-2, slug-3, ... if an earlier note already
// took it. A Windows reserved name gets a "-note" suffix first. Slugs are
// lower case, so this also keeps names apart on case-insensitive filesystems.
func (s *markdownSlugs) unique(slug string) string {
	if windowsReservedNames[slug] {
		slug += "-note"
	}
	candidate := slug
	n := max(s.next[slug], 2)
	for s.used[candidate] {
		candidate = slug + "-" + strconv.Itoa(n)
		n++
	}
	s.next[slug] = n
	s.used[candidate] = true
	return candidate
}
