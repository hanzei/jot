package models

import (
	"errors"
	"fmt"
	"regexp"
	"unicode/utf8"

	"github.com/sirupsen/logrus"
)

// Note and label field limits, enforced by every write surface (the REST
// handlers and the MCP server). They live here rather than in one handler
// package so both share a single definition. All character limits are measured
// in Unicode code points (utf8.RuneCountInString).
// Keep in sync with shared/src/constants.ts VALIDATION.
const (
	NoteTitleMaxLength   = 200
	NoteContentMaxLength = 10000
	// LabelNameMaxLength caps a label name. Labels are rendered as chips in the
	// sidebar, on note cards and in pickers, where anything much longer than a
	// short phrase is truncated anyway; 100 matches the PAT name limit and
	// leaves room for multi-word names in any script.
	LabelNameMaxLength = 100
)

// ErrLabelNameTooLong is returned by the label store when a name exceeds
// LabelNameMaxLength. Handlers map it to 422 (a resource cap, not malformed
// input).
var ErrLabelNameTooLong = fmt.Errorf("label name must be %d characters or fewer", LabelNameMaxLength)

var hexColorRegex = regexp.MustCompile(`^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`)

// ValidateNoteTitle enforces the note title length limit.
func ValidateNoteTitle(title string) error {
	if utf8.RuneCountInString(title) > NoteTitleMaxLength {
		return fmt.Errorf("title must be %d characters or fewer", NoteTitleMaxLength)
	}
	return nil
}

// ValidateNoteContent enforces the note content length limit.
func ValidateNoteContent(content string) error {
	if utf8.RuneCountInString(content) > NoteContentMaxLength {
		return fmt.Errorf("content must be %d characters or fewer", NoteContentMaxLength)
	}
	return nil
}

// ValidateNoteColor checks that color is a CSS hex color (#rgb or #rrggbb).
func ValidateNoteColor(color string) error {
	if !hexColorRegex.MatchString(color) {
		return errors.New("color must be a valid CSS hex color (e.g. #fff or #ffffff)")
	}
	return nil
}

// ValidateLabelName enforces the label name length limit. Callers trim and
// reject empty names themselves, since what counts as empty differs by surface.
func ValidateLabelName(name string) error {
	if utf8.RuneCountInString(name) > LabelNameMaxLength {
		return ErrLabelNameTooLong
	}
	return nil
}

// ValidateNoteTypeFields rejects values for fields that do not belong to
// noteType: a title on a text note, content on a list note, and the
// checked-items toggle on a text note. A nil pointer means the field is not
// being set; an empty title or content is always allowed, since it is what the
// field reads as anyway.
func ValidateNoteTypeFields(noteType NoteType, title, content *string, checkedItemsCollapsed *bool) error {
	if noteType == NoteTypeText && title != nil && *title != "" {
		return errors.New("text notes cannot have a title")
	}
	if noteType == NoteTypeList && content != nil && *content != "" {
		return errors.New("list notes cannot have content")
	}
	if noteType == NoteTypeText && checkedItemsCollapsed != nil {
		return errors.New("text notes cannot have checked_items_collapsed")
	}
	return nil
}

// SanitizeNote strips fields that do not belong to the note's type. The Note
// struct is unified (a single DB table), so a row can carry, say, a title on a
// text note — written before the rule was enforced everywhere, or left behind
// by a type conversion. Every surface that returns or publishes a note passes
// it through here so clients never see such a field.
func SanitizeNote(n Note) Note {
	switch n.NoteType {
	case NoteTypeText:
		n.Title = ""
		n.Items = nil
		n.CheckedItemsCollapsed = false
	case NoteTypeList:
		n.Content = ""
	default:
		logrus.Warnf("SanitizeNote: unknown note type %q for note %s", n.NoteType, n.ID)
	}
	return n
}

// SanitizeNotes applies SanitizeNote to every note in notes.
func SanitizeNotes(notes []*Note) []Note {
	sanitized := make([]Note, len(notes))
	for i, n := range notes {
		sanitized[i] = SanitizeNote(*n)
	}
	return sanitized
}
