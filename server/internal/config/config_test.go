package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadDefaults(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("DB_PATH", "")
	t.Setenv("STATIC_DIR", "/tmp/static")
	t.Setenv("CORS_ALLOWED_ORIGIN", "")
	t.Setenv("COOKIE_SECURE", "")

	cfg, err := Load()
	require.NoError(t, err)

	assert.Equal(t, 8080, cfg.Port)
	assert.Equal(t, "./jot.db", cfg.DBPath)
	assert.Equal(t, "/tmp/static", cfg.StaticDir)
	assert.Equal(t, "http://localhost:5173", cfg.CORSAllowedOrigin)
	assert.True(t, cfg.CookieSecure)
}

func TestLoadCustomValues(t *testing.T) {
	t.Setenv("PORT", "3000")
	t.Setenv("DB_PATH", "/data/my.db")
	t.Setenv("STATIC_DIR", "/var/www/")
	t.Setenv("CORS_ALLOWED_ORIGIN", "https://example.com")
	t.Setenv("COOKIE_SECURE", "false")

	cfg, err := Load()
	require.NoError(t, err)

	assert.Equal(t, 3000, cfg.Port)
	assert.Equal(t, "/data/my.db", cfg.DBPath)
	assert.Equal(t, "/var/www", cfg.StaticDir)
	assert.Equal(t, "https://example.com", cfg.CORSAllowedOrigin)
	assert.False(t, cfg.CookieSecure)
}

func TestLoadInvalidPort(t *testing.T) {
	t.Setenv("PORT", "notanumber")
	t.Setenv("STATIC_DIR", "/tmp/static")

	_, err := Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid PORT value")
}

func TestLoadStaticDirDefault(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("DB_PATH", "")
	t.Setenv("STATIC_DIR", "")
	t.Setenv("CORS_ALLOWED_ORIGIN", "")
	t.Setenv("COOKIE_SECURE", "")

	cfg, err := Load()
	require.NoError(t, err)
	assert.Contains(t, cfg.StaticDir, "webapp/build")
}

func TestLoadCookieSecureDefault(t *testing.T) {
	t.Setenv("COOKIE_SECURE", "")
	t.Setenv("STATIC_DIR", "/tmp/static")

	cfg, err := Load()
	require.NoError(t, err)
	assert.True(t, cfg.CookieSecure)
}

func TestLoadCookieSecureExplicitTrue(t *testing.T) {
	t.Setenv("COOKIE_SECURE", "true")
	t.Setenv("STATIC_DIR", "/tmp/static")

	cfg, err := Load()
	require.NoError(t, err)
	assert.True(t, cfg.CookieSecure)
}
