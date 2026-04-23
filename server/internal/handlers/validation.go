package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/hanzei/jot/server/internal/models"
)

// decodeJSONBody limits the request body to maxJSONBodySize and decodes it
// into v. Handlers that accept larger bodies (e.g. multipart uploads) must
// not call this function and should set their own limit instead.
func decodeJSONBody(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodySize)
	return json.NewDecoder(r.Body).Decode(v)
}

var usernameRegex = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

var hexColorRegex = regexp.MustCompile(`^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`)

// Keep in sync with shared/src/constants.ts VALIDATION for clients.
// All character limits are measured in Unicode code points (utf8.RuneCountInString).
// noteItemsMaxCount is a server-only resource cap with no shared-constants counterpart.
// passwordMinLength is configurable via config.Config.PasswordMinLength (env PASSWORD_MIN_LENGTH).
const (
	noteTitleMaxLength    = 200
	noteContentMaxLength  = 10000
	noteItemTextMaxLength = 500
	noteItemsMaxCount     = 500
	searchQueryMaxLength  = 500
	patNameMaxLength      = 100
	// maxPATsPerUser caps the number of personal access tokens a user can hold.
	// Keep in sync with shared/src/constants.ts VALIDATION.PAT_MAX_COUNT.
	maxPATsPerUser = 50
	// maxJSONBodySize is the maximum request body size for JSON endpoints.
	maxJSONBodySize = 1 << 20 // 1 MiB
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

func validatePassword(password string, minLength int) error {
	if utf8.RuneCountInString(password) < minLength {
		return fmt.Errorf("password must be at least %d characters", minLength)
	}
	return nil
}

func validateSearchQuery(q string) error {
	if utf8.RuneCountInString(q) > searchQueryMaxLength {
		return fmt.Errorf("search query must be %d characters or fewer", searchQueryMaxLength)
	}
	return nil
}

func validateColor(color string) error {
	if !hexColorRegex.MatchString(color) {
		return errors.New("color must be a valid CSS hex color (e.g. #fff or #ffffff)")
	}
	return nil
}

func validatePATName(name string) error {
	n := utf8.RuneCountInString(name)
	if n == 0 {
		return errors.New("token name must not be empty")
	}
	if n > patNameMaxLength {
		return fmt.Errorf("token name must be %d characters or fewer", patNameMaxLength)
	}
	return nil
}

// validatePATExpiresAt ensures a caller-supplied PAT expiry is a sensible
// absolute timestamp in the future and no further out than PATMaxLifetime.
func validatePATExpiresAt(expiresAt time.Time) error {
	if expiresAt.IsZero() {
		return errors.New("expires_at must not be zero")
	}
	now := time.Now()
	if expiresAt.Sub(now) < models.PATMinLifetime {
		return fmt.Errorf("expires_at must be at least %s in the future", models.PATMinLifetime)
	}
	if expiresAt.Sub(now) > models.PATMaxLifetime {
		return fmt.Errorf("expires_at must be at most %s in the future", models.PATMaxLifetime)
	}
	return nil
}

// normalizeLabels trims whitespace from each label name, drops empty names, and
// removes duplicates while preserving first-occurrence order.
func normalizeLabels(rawLabels []string) []string {
	seen := make(map[string]struct{})
	result := make([]string, 0, len(rawLabels))
	for _, raw := range rawLabels {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		if _, dup := seen[name]; dup {
			continue
		}
		seen[name] = struct{}{}
		result = append(result, name)
	}
	return result
}

// truncateRunes returns s truncated to at most max Unicode code points.
func truncateRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	runes := []rune(s)
	return string(runes[:max])
}
