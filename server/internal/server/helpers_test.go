package server

import (
	"testing"

	"github.com/hanzei/jot/server/internal/config"
)

// newTestConfig returns a minimal sqlite config rooted in a fresh temp dir.
func newTestConfig(t *testing.T) *config.Config {
	t.Helper()
	tmpDir := t.TempDir()
	return &config.Config{
		DBDriver:          "sqlite",
		DBDSN:             tmpDir + "/test.db",
		StaticDir:         tmpDir,
		UploadDir:         tmpDir + "/uploads",
		UploadMaxBytes:    25 << 20,
		PasswordMinLength: 10,
		LocalLoginEnabled: true,
	}
}
