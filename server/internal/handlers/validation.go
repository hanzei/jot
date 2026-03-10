package handlers

import (
	"errors"
	"regexp"
	"strings"
)

func validateUsername(username string) error {
	if len(username) < 2 {
		return errors.New("username must be at least 2 characters")
	}
	if len(username) > 30 {
		return errors.New("username must be less than 30 characters")
	}

	// Username can only contain letters, numbers, underscores, and hyphens
	usernameRegex := regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
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
	const minPasswordLength = 4
	if len(password) < minPasswordLength {
		return errors.New("password must be at least 4 characters")
	}
	return nil
}
