package config

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadDefaults(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("DB_DRIVER", "")
	t.Setenv("DB_DSN", "")
	t.Setenv("DB_PATH", "")
	t.Setenv("STATIC_DIR", "")
	t.Setenv("CORS_ALLOWED_ORIGIN", "")
	t.Setenv("COOKIE_SECURE", "")
	t.Setenv("REGISTRATION_ENABLED", "")
	t.Setenv("PASSWORD_MIN_LENGTH", "")

	cfg, err := Load()
	require.NoError(t, err)

	assert.Equal(t, 8080, cfg.Port)
	assert.Equal(t, "sqlite", cfg.DBDriver)
	assert.Equal(t, "./jot.db", cfg.DBDSN)
	assert.Contains(t, cfg.StaticDir, filepath.Join("webapp", "build"))
	assert.Empty(t, cfg.CORSAllowedOrigin)
	assert.True(t, cfg.CookieSecure)
	assert.True(t, cfg.RegistrationEnabled)
	assert.Equal(t, 10, cfg.PasswordMinLength)
}

func TestLoadCustomValues(t *testing.T) {
	t.Setenv("PORT", "3000")
	t.Setenv("DB_DRIVER", "postgres")
	t.Setenv("DB_DSN", "postgres://user:pass@localhost/jot")
	t.Setenv("STATIC_DIR", "/var/www/")
	t.Setenv("CORS_ALLOWED_ORIGIN", "https://example.com")
	t.Setenv("COOKIE_SECURE", "false")
	t.Setenv("REGISTRATION_ENABLED", "false")
	t.Setenv("PASSWORD_MIN_LENGTH", "4")

	cfg, err := Load()
	require.NoError(t, err)

	assert.Equal(t, 3000, cfg.Port)
	assert.Equal(t, "postgres", cfg.DBDriver)
	assert.Equal(t, "postgres://user:pass@localhost/jot", cfg.DBDSN)
	assert.Equal(t, "/var/www", cfg.StaticDir)
	assert.Equal(t, "https://example.com", cfg.CORSAllowedOrigin)
	assert.False(t, cfg.CookieSecure)
	assert.False(t, cfg.RegistrationEnabled)
	assert.Equal(t, 4, cfg.PasswordMinLength)
}

func TestLoadDBPathAlias(t *testing.T) {
	t.Setenv("DB_DRIVER", "")
	t.Setenv("DB_DSN", "")
	t.Setenv("DB_PATH", "/data/my.db")
	t.Setenv("STATIC_DIR", "/tmp/static")

	cfg, err := Load()
	require.NoError(t, err)

	assert.Equal(t, "sqlite", cfg.DBDriver)
	assert.Equal(t, "/data/my.db", cfg.DBDSN)
}

func TestLoadInvalidPort(t *testing.T) {
	t.Setenv("STATIC_DIR", "/tmp/static")

	t.Run("non-numeric", func(t *testing.T) {
		t.Setenv("PORT", "notanumber")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid PORT value")
	})

	t.Run("zero", func(t *testing.T) {
		t.Setenv("PORT", "0")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "must be between 1 and 65535")
	})

	t.Run("negative", func(t *testing.T) {
		t.Setenv("PORT", "-1")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "must be between 1 and 65535")
	})

	t.Run("too high", func(t *testing.T) {
		t.Setenv("PORT", "65536")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "must be between 1 and 65535")
	})

	t.Run("max valid", func(t *testing.T) {
		t.Setenv("PORT", "65535")
		cfg, err := Load()
		require.NoError(t, err)
		assert.Equal(t, 65535, cfg.Port)
	})
}

func TestLoadStaticDirDefault(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("DB_PATH", "")
	t.Setenv("STATIC_DIR", "")
	t.Setenv("CORS_ALLOWED_ORIGIN", "")
	t.Setenv("COOKIE_SECURE", "")

	cfg, err := Load()
	require.NoError(t, err)
	assert.Contains(t, cfg.StaticDir, filepath.Join("webapp", "build"))
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

func TestLoadRegistrationEnabledDefault(t *testing.T) {
	t.Setenv("REGISTRATION_ENABLED", "")
	t.Setenv("STATIC_DIR", "/tmp/static")

	cfg, err := Load()
	require.NoError(t, err)
	assert.True(t, cfg.RegistrationEnabled)
}

func TestLoadRegistrationDisabled(t *testing.T) {
	t.Setenv("REGISTRATION_ENABLED", "false")
	t.Setenv("STATIC_DIR", "/tmp/static")

	cfg, err := Load()
	require.NoError(t, err)
	assert.False(t, cfg.RegistrationEnabled)
}

func TestLoadRegistrationExplicitTrue(t *testing.T) {
	t.Setenv("REGISTRATION_ENABLED", "true")
	t.Setenv("STATIC_DIR", "/tmp/static")

	cfg, err := Load()
	require.NoError(t, err)
	assert.True(t, cfg.RegistrationEnabled)
}

func TestLoadCORSAllowedOriginSet(t *testing.T) {
	t.Setenv("CORS_ALLOWED_ORIGIN", "https://app.example.com")
	t.Setenv("STATIC_DIR", "/tmp/static")

	cfg, err := Load()
	require.NoError(t, err)
	assert.Equal(t, "https://app.example.com", cfg.CORSAllowedOrigin)
}

func TestLoadPasswordMinLength(t *testing.T) {
	t.Setenv("STATIC_DIR", "/tmp/static")

	t.Run("default", func(t *testing.T) {
		t.Setenv("PASSWORD_MIN_LENGTH", "")
		cfg, err := Load()
		require.NoError(t, err)
		assert.Equal(t, 10, cfg.PasswordMinLength)
	})

	t.Run("custom", func(t *testing.T) {
		t.Setenv("PASSWORD_MIN_LENGTH", "4")
		cfg, err := Load()
		require.NoError(t, err)
		assert.Equal(t, 4, cfg.PasswordMinLength)
	})

	t.Run("non-numeric", func(t *testing.T) {
		t.Setenv("PASSWORD_MIN_LENGTH", "notanumber")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid PASSWORD_MIN_LENGTH value")
	})

	t.Run("zero", func(t *testing.T) {
		t.Setenv("PASSWORD_MIN_LENGTH", "0")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "must be between 1 and 72")
	})

	t.Run("negative", func(t *testing.T) {
		t.Setenv("PASSWORD_MIN_LENGTH", "-1")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "must be between 1 and 72")
	})

	t.Run("too high", func(t *testing.T) {
		t.Setenv("PASSWORD_MIN_LENGTH", "73")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "must be between 1 and 72")
	})

	t.Run("max valid", func(t *testing.T) {
		t.Setenv("PASSWORD_MIN_LENGTH", "72")
		cfg, err := Load()
		require.NoError(t, err)
		assert.Equal(t, 72, cfg.PasswordMinLength)
	})
}
