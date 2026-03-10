package handlers

import (
	"regexp"
	"strings"
)

func validateUsername(username string) error {
	if len(username) < 2 {
		return ErrUsernameMinLength
	}
	if len(username) > 30 {
		return ErrUsernameMaxLength
	}

	// Username can only contain letters, numbers, underscores, and hyphens
	usernameRegex := regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
	if !usernameRegex.MatchString(username) {
		return ErrUsernameInvalidChars
	}

	// Username cannot start or end with underscore or hyphen
	if strings.HasPrefix(username, "_") || strings.HasPrefix(username, "-") ||
		strings.HasSuffix(username, "_") || strings.HasSuffix(username, "-") {
		return ErrUsernameInvalidStartEnd
	}

	return nil
}

func validatePassword(password string) error {
	const minPasswordLength = 4
	if len(password) < minPasswordLength {
		return ErrPasswordTooShort
	}
	return nil
}
