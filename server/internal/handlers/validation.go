package handlers

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

var usernameRegex = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

var hexColorRegex = regexp.MustCompile(`^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`)

// Keep in sync with shared/src/constants.ts VALIDATION and PASSWORD_MIN_LENGTH for clients.
// All character limits are measured in Unicode code points (utf8.RuneCountInString).
// noteItemsMaxCount is a server-only resource cap with no shared-constants counterpart.
const (
	passwordMinLength     = 4
	noteTitleMaxLength    = 200
	noteContentMaxLength  = 10000
	noteItemTextMaxLength = 500
	noteItemsMaxCount     = 500
	searchQueryMaxLength  = 200
)

func validateUsername(username string) error {
	n := utf8.RuneCountInString(username)
	if n < 2 {
		return errors.New("username must be at least 2 characters")
	}
	if n > 30 {
		return errors.New("username must be 30 characters or fewer")
	}

	// Username can only contain letters, numbers, underscores, and hyphens
	if !usernameRegex.MatchString(username) {
		return errors.New("username can only contain letters, numbers, underscores, and hyphens")
	}

	// Username cannot start or end with underscore or hyphen
	if strings.HasPrefix(username, "_") || strings.HasPrefix(username, "-") ||
		strings.HasSuffix(username, "_") || strings.HasSuffix(username, "-") {
		return errors.New("username cannot start or end with underscore or hyphen")
	}

	return nil
}

func validatePassword(password string) error {
	if len(password) < passwordMinLength {
		return fmt.Errorf("password must be at least %d characters", passwordMinLength)
	}
	return nil
}

func validateColor(color string) error {
	if !hexColorRegex.MatchString(color) {
		return errors.New("color must be a valid CSS hex color (e.g. #fff or #ffffff)")
	}
	return nil
}

// truncateRunes returns s truncated to at most max Unicode code points.
func truncateRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	runes := []rune(s)
	return string(runes[:max])
}
