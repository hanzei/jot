package models

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// ConvertedListItem is one line of text-note content parsed into a list item.
type ConvertedListItem struct {
	Text      string
	Completed bool
}

// Heuristic, line-oriented markdown stripping — not a full parser. It only
// needs to handle the syntax subset the webapp's markdown renderer supports
// (headings, bold/italic, inline code, links, blockquotes, lists), and must
// stay in sync with shared/src/noteConversion.ts, which applies the same
// rules client-side for the mobile app's offline conversion.
var (
	conversionListMarkerRe = regexp.MustCompile(`^(?:[-*+]|\d+\.)\s+(?:\[([ xX])\]\s*)?`)
	conversionBlockquoteRe = regexp.MustCompile(`^(?:>\s*)+`)
	conversionHeadingRe    = regexp.MustCompile(`^#{1,6}\s+`)
	conversionLinkRe       = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	conversionCodeRe       = regexp.MustCompile("`([^`]+)`")
	conversionBoldRe       = regexp.MustCompile(`\*\*(.+?)\*\*|__(.+?)__`)
	conversionItalicRe     = regexp.MustCompile(`\*(.+?)\*|_(.+?)_`)
)

func stripInlineMarkdownFormatting(text string) string {
	text = conversionLinkRe.ReplaceAllString(text, "$1")
	text = conversionCodeRe.ReplaceAllString(text, "$1")
	text = replaceFirstNonEmptyGroup(conversionBoldRe, text)
	text = replaceFirstNonEmptyGroup(conversionItalicRe, text)
	return strings.TrimSpace(text)
}

// replaceFirstNonEmptyGroup replaces every match of re in text with whichever
// of its two alternative capture groups matched (the pattern's two branches,
// e.g. **bold** vs __bold__, are mutually exclusive per match).
func replaceFirstNonEmptyGroup(re *regexp.Regexp, text string) string {
	return re.ReplaceAllStringFunc(text, func(match string) string {
		groups := re.FindStringSubmatch(match)
		if groups[1] != "" {
			return groups[1]
		}
		return groups[2]
	})
}

// ParseTextLineAsListItem parses one line of text-note content into a list
// item: it strips a leading list/checkbox marker (recording completed state)
// and any inline markdown formatting. ok is false for a line that is blank
// once stripped.
func ParseTextLineAsListItem(rawLine string) (item ConvertedListItem, ok bool) {
	line := strings.TrimSpace(rawLine)
	if line == "" {
		return ConvertedListItem{}, false
	}

	var completed bool
	if m := conversionListMarkerRe.FindStringSubmatch(line); m != nil {
		line = line[len(m[0]):]
		if m[1] != "" {
			completed = strings.EqualFold(m[1], "x")
		}
	}

	line = conversionBlockquoteRe.ReplaceAllString(line, "")
	line = conversionHeadingRe.ReplaceAllString(line, "")
	line = stripInlineMarkdownFormatting(line)

	if line == "" {
		return ConvertedListItem{}, false
	}
	return ConvertedListItem{Text: line, Completed: completed}, true
}

// TextToListItems converts text-note content into a flat list of top-level
// list items, dropping blank lines.
func TextToListItems(content string) []ConvertedListItem {
	lines := strings.Split(content, "\n")
	items := make([]ConvertedListItem, 0, len(lines))
	for _, line := range lines {
		if item, ok := ParseTextLineAsListItem(line); ok {
			items = append(items, item)
		}
	}
	return items
}

// ListToText renders a list note's title and items back into text-note
// content. The title (if any) becomes an h1 line; items become a markdown
// task list, with one level of indentation for items nested under a
// top-level item.
func ListToText(title string, items []NoteItem) string {
	var lines []string
	if trimmedTitle := strings.TrimSpace(title); trimmedTitle != "" {
		lines = append(lines, "# "+trimmedTitle, "")
	}

	childrenByParent := make(map[string][]NoteItem)
	var topLevel []NoteItem
	for _, item := range items {
		if item.ParentID == nil {
			topLevel = append(topLevel, item)
			continue
		}
		childrenByParent[*item.ParentID] = append(childrenByParent[*item.ParentID], item)
	}
	slices.SortStableFunc(topLevel, func(a, b NoteItem) int { return a.Position - b.Position })

	for _, parent := range topLevel {
		lines = append(lines, renderConversionItemLine(parent, 0))
		children := childrenByParent[parent.ID]
		slices.SortStableFunc(children, func(a, b NoteItem) int { return a.Position - b.Position })
		for _, child := range children {
			lines = append(lines, renderConversionItemLine(child, 1))
		}
	}

	return strings.Join(lines, "\n")
}

func renderConversionItemLine(item NoteItem, depth int) string {
	box := "[ ]"
	if item.Completed {
		box = "[x]"
	}
	return fmt.Sprintf("%s- %s %s", strings.Repeat("  ", depth), box, item.Text)
}
