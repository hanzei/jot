package config

import (
	"fmt"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLoadDefaults(t *testing.T) {
	t.Setenv("JOT_PORT", "")
	t.Setenv("JOT_DB_DRIVER", "")
	t.Setenv("JOT_DB_DSN", "")
	t.Setenv("JOT_UPLOAD_DIR", "")
	t.Setenv("JOT_STATIC_DIR", "")
	t.Setenv("JOT_CORS_ALLOWED_ORIGIN", "")
	t.Setenv("JOT_COOKIE_SECURE", "")
	t.Setenv("JOT_REGISTRATION_ENABLED", "")
	t.Setenv("JOT_PASSWORD_MIN_LENGTH", "")

	cfg, err := Load()
	require.NoError(t, err)

	assert.Equal(t, 8080, cfg.Port)
	assert.Equal(t, "sqlite", cfg.DBDriver)
	assert.Equal(t, "./jot.db", cfg.DBDSN)
	assert.Equal(t, "./uploads", cfg.UploadDir)
	assert.Contains(t, cfg.StaticDir, filepath.Join("webapp", "build"))
	assert.Empty(t, cfg.CORSAllowedOrigin)
	assert.True(t, cfg.CookieSecure)
	assert.True(t, cfg.RegistrationEnabled)
	assert.Equal(t, 10, cfg.PasswordMinLength)
}

func TestLoadCustomValues(t *testing.T) {
	t.Setenv("JOT_PORT", "3000")
	t.Setenv("JOT_DB_DRIVER", "postgres")
	t.Setenv("JOT_DB_DSN", "postgres://user:pass@localhost/jot")
	t.Setenv("JOT_UPLOAD_DIR", "/var/lib/jot/uploads/")
	t.Setenv("JOT_STATIC_DIR", "/var/www/")
	t.Setenv("JOT_CORS_ALLOWED_ORIGIN", "https://example.com")
	t.Setenv("JOT_COOKIE_SECURE", "false")
	t.Setenv("JOT_REGISTRATION_ENABLED", "false")
	t.Setenv("JOT_PASSWORD_MIN_LENGTH", "4")

	cfg, err := Load()
	require.NoError(t, err)

	assert.Equal(t, 3000, cfg.Port)
	assert.Equal(t, "postgres", cfg.DBDriver)
	assert.Equal(t, "postgres://user:pass@localhost/jot", cfg.DBDSN)
	assert.Equal(t, "/var/lib/jot/uploads", cfg.UploadDir)
	assert.Equal(t, "/var/www", cfg.StaticDir)
	assert.Equal(t, "https://example.com", cfg.CORSAllowedOrigin)
	assert.False(t, cfg.CookieSecure)
	assert.False(t, cfg.RegistrationEnabled)
	assert.Equal(t, 4, cfg.PasswordMinLength)
}

func TestLoadInvalidPort(t *testing.T) {
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")

	t.Run("non-numeric", func(t *testing.T) {
		t.Setenv("JOT_PORT", "notanumber")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid JOT_PORT value")
	})

	t.Run("zero", func(t *testing.T) {
		t.Setenv("JOT_PORT", "0")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "must be between 1 and 65535")
	})

	t.Run("negative", func(t *testing.T) {
		t.Setenv("JOT_PORT", "-1")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "must be between 1 and 65535")
	})

	t.Run("too high", func(t *testing.T) {
		t.Setenv("JOT_PORT", "65536")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "must be between 1 and 65535")
	})

	t.Run("max valid", func(t *testing.T) {
		t.Setenv("JOT_PORT", "65535")
		cfg, err := Load()
		require.NoError(t, err)
		assert.Equal(t, 65535, cfg.Port)
	})
}

func TestLoadStaticDirDefault(t *testing.T) {
	t.Setenv("JOT_PORT", "")
	t.Setenv("JOT_DB_DSN", "")
	t.Setenv("JOT_STATIC_DIR", "")
	t.Setenv("JOT_CORS_ALLOWED_ORIGIN", "")
	t.Setenv("JOT_COOKIE_SECURE", "")

	cfg, err := Load()
	require.NoError(t, err)
	assert.Contains(t, cfg.StaticDir, filepath.Join("webapp", "build"))
}

func TestLoadCookieSecureDefault(t *testing.T) {
	t.Setenv("JOT_COOKIE_SECURE", "")
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")

	cfg, err := Load()
	require.NoError(t, err)
	assert.True(t, cfg.CookieSecure)
}

func TestLoadCookieSecureExplicitTrue(t *testing.T) {
	t.Setenv("JOT_COOKIE_SECURE", "true")
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")

	cfg, err := Load()
	require.NoError(t, err)
	assert.True(t, cfg.CookieSecure)
}

func TestLoadRegistrationEnabledDefault(t *testing.T) {
	t.Setenv("JOT_REGISTRATION_ENABLED", "")
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")

	cfg, err := Load()
	require.NoError(t, err)
	assert.True(t, cfg.RegistrationEnabled)
}

func TestLoadRegistrationDisabled(t *testing.T) {
	t.Setenv("JOT_REGISTRATION_ENABLED", "false")
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")

	cfg, err := Load()
	require.NoError(t, err)
	assert.False(t, cfg.RegistrationEnabled)
}

func TestLoadRegistrationExplicitTrue(t *testing.T) {
	t.Setenv("JOT_REGISTRATION_ENABLED", "true")
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")

	cfg, err := Load()
	require.NoError(t, err)
	assert.True(t, cfg.RegistrationEnabled)
}

func TestLoadRegistrationInvalidValueErrors(t *testing.T) {
	// A non-boolean value must fail loudly rather than being silently ignored
	// (which previously left registration enabled contrary to intent).
	for _, v := range []string{"False", "0", "no", "disabled"} {
		t.Run(v, func(t *testing.T) {
			t.Setenv("JOT_REGISTRATION_ENABLED", v)
			t.Setenv("JOT_STATIC_DIR", "/tmp/static")

			_, err := Load()
			assert.Error(t, err)
		})
	}
}

func TestLoadCORSAllowedOriginSet(t *testing.T) {
	t.Setenv("JOT_CORS_ALLOWED_ORIGIN", "https://app.example.com")
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")

	cfg, err := Load()
	require.NoError(t, err)
	assert.Equal(t, "https://app.example.com", cfg.CORSAllowedOrigin)
}

func TestLoadUploadMaxBytes(t *testing.T) {
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")

	t.Run("default", func(t *testing.T) {
		t.Setenv("JOT_UPLOAD_MAX_BYTES", "")
		cfg, err := Load()
		require.NoError(t, err)
		assert.Equal(t, 25<<20, cfg.UploadMaxBytes)
	})

	t.Run("custom", func(t *testing.T) {
		t.Setenv("JOT_UPLOAD_MAX_BYTES", "1048576")
		cfg, err := Load()
		require.NoError(t, err)
		assert.Equal(t, 1<<20, cfg.UploadMaxBytes)
	})

	t.Run("non-numeric", func(t *testing.T) {
		t.Setenv("JOT_UPLOAD_MAX_BYTES", "notanumber")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid JOT_UPLOAD_MAX_BYTES value")
	})

	t.Run("too low", func(t *testing.T) {
		t.Setenv("JOT_UPLOAD_MAX_BYTES", "1")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "must be between")
	})

	t.Run("too high", func(t *testing.T) {
		t.Setenv("JOT_UPLOAD_MAX_BYTES", fmt.Sprint(501<<20))
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "must be between")
	})
}

func TestLoadPasswordMinLength(t *testing.T) {
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")

	t.Run("default", func(t *testing.T) {
		t.Setenv("JOT_PASSWORD_MIN_LENGTH", "")
		cfg, err := Load()
		require.NoError(t, err)
		assert.Equal(t, 10, cfg.PasswordMinLength)
	})

	t.Run("custom", func(t *testing.T) {
		t.Setenv("JOT_PASSWORD_MIN_LENGTH", "4")
		cfg, err := Load()
		require.NoError(t, err)
		assert.Equal(t, 4, cfg.PasswordMinLength)
	})

	t.Run("non-numeric", func(t *testing.T) {
		t.Setenv("JOT_PASSWORD_MIN_LENGTH", "notanumber")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid JOT_PASSWORD_MIN_LENGTH value")
	})

	t.Run("zero", func(t *testing.T) {
		t.Setenv("JOT_PASSWORD_MIN_LENGTH", "0")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "must be between 1 and 72")
	})

	t.Run("negative", func(t *testing.T) {
		t.Setenv("JOT_PASSWORD_MIN_LENGTH", "-1")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "must be between 1 and 72")
	})

	t.Run("too high", func(t *testing.T) {
		t.Setenv("JOT_PASSWORD_MIN_LENGTH", "73")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "must be between 1 and 72")
	})

	t.Run("max valid", func(t *testing.T) {
		t.Setenv("JOT_PASSWORD_MIN_LENGTH", "72")
		cfg, err := Load()
		require.NoError(t, err)
		assert.Equal(t, 72, cfg.PasswordMinLength)
	})
}

func TestLoadRateLimitValues(t *testing.T) {
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")

	t.Run("defaults", func(t *testing.T) {
		t.Setenv("JOT_RATE_LIMIT_ENABLED", "")
		t.Setenv("JOT_RATE_LIMIT_PER_MINUTE", "")
		t.Setenv("JOT_RATE_LIMIT_AUTH_PER_MINUTE", "")
		t.Setenv("JOT_RATE_LIMIT_EXPENSIVE_PER_MINUTE", "")

		cfg, err := Load()
		require.NoError(t, err)

		assert.True(t, cfg.RateLimitEnabled)
		assert.Equal(t, 300, cfg.RateLimitPerMinute)
		assert.Equal(t, 20, cfg.RateLimitAuthPerMinute)
		assert.Equal(t, 20, cfg.RateLimitExpensivePerMinute)
	})

	t.Run("custom", func(t *testing.T) {
		t.Setenv("JOT_RATE_LIMIT_ENABLED", "false")
		t.Setenv("JOT_RATE_LIMIT_PER_MINUTE", "600")
		t.Setenv("JOT_RATE_LIMIT_AUTH_PER_MINUTE", "5")
		t.Setenv("JOT_RATE_LIMIT_EXPENSIVE_PER_MINUTE", "10")

		cfg, err := Load()
		require.NoError(t, err)

		assert.False(t, cfg.RateLimitEnabled)
		assert.Equal(t, 600, cfg.RateLimitPerMinute)
		assert.Equal(t, 5, cfg.RateLimitAuthPerMinute)
		assert.Equal(t, 10, cfg.RateLimitExpensivePerMinute)
	})
}

func TestLoadRateLimitInvalidValueErrors(t *testing.T) {
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")

	t.Run("enabled not a bool", func(t *testing.T) {
		t.Setenv("JOT_RATE_LIMIT_ENABLED", "yes")
		_, err := Load()
		assert.Error(t, err)
	})

	t.Run("per-minute not a number", func(t *testing.T) {
		t.Setenv("JOT_RATE_LIMIT_ENABLED", "")
		t.Setenv("JOT_RATE_LIMIT_PER_MINUTE", "notanumber")
		_, err := Load()
		assert.Error(t, err)
	})

	t.Run("per-minute zero", func(t *testing.T) {
		t.Setenv("JOT_RATE_LIMIT_PER_MINUTE", "0")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "must be between")
	})
}

func TestLoadOTelSignalToggles(t *testing.T) {
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")

	t.Run("defaults", func(t *testing.T) {
		t.Setenv("JOT_OTEL_TRACES_ENABLED", "")
		t.Setenv("JOT_OTEL_METRICS_ENABLED", "")
		t.Setenv("JOT_OTEL_LOGS_ENABLED", "")

		cfg, err := Load()
		require.NoError(t, err)

		assert.False(t, cfg.OTelTracesEnabled)
		assert.False(t, cfg.OTelMetricsEnabled)
		assert.False(t, cfg.OTelLogsEnabled)
	})

	t.Run("custom", func(t *testing.T) {
		t.Setenv("JOT_OTEL_TRACES_ENABLED", "true")
		t.Setenv("JOT_OTEL_METRICS_ENABLED", "true")
		t.Setenv("JOT_OTEL_LOGS_ENABLED", "true")

		cfg, err := Load()
		require.NoError(t, err)

		assert.True(t, cfg.OTelTracesEnabled)
		assert.True(t, cfg.OTelMetricsEnabled)
		assert.True(t, cfg.OTelLogsEnabled)
	})
}

// TestLoadUnprefixedOTelSDKVarsUnaffected verifies the spec-standard OTel SDK
// env vars (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_INSECURE,
// OTEL_SERVICE_NAME) are read as-is, without a JOT_ prefix and without legacy
// fallback machinery — the OTel SDK's own conventions apply here, not Jot's.
func TestLoadUnprefixedOTelSDKVarsUnaffected(t *testing.T) {
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "localhost:4317")
	t.Setenv("OTEL_EXPORTER_OTLP_INSECURE", "true")
	t.Setenv("OTEL_SERVICE_NAME", "custom-service")

	cfg, err := Load()
	require.NoError(t, err)

	assert.Equal(t, "localhost:4317", cfg.OTelEndpoint)
	assert.True(t, cfg.OTelInsecure)
	assert.Equal(t, "custom-service", cfg.OTelServiceName)
}

// TestLoadLegacyEnvFallback verifies that pre-JOT_-prefix env var names
// still work as a deprecated fallback, for backward compatibility with
// existing installs during the transition period (removal targeted at the
// v1.0 stable release).
func TestLoadLegacyEnvFallback(t *testing.T) {
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")
	t.Setenv("PORT", "9000")
	t.Setenv("DB_DRIVER", "postgres")
	t.Setenv("COOKIE_SECURE", "false")
	t.Setenv("RATE_LIMIT_PER_MINUTE", "42")
	t.Setenv("OTEL_TRACES_ENABLED", "true")

	cfg, err := Load()
	require.NoError(t, err)

	assert.Equal(t, 9000, cfg.Port)
	assert.Equal(t, "postgres", cfg.DBDriver)
	assert.False(t, cfg.CookieSecure)
	assert.Equal(t, 42, cfg.RateLimitPerMinute)
	assert.True(t, cfg.OTelTracesEnabled)
}

// TestLoadJOTPrefixTakesPrecedenceOverLegacy verifies that when both the
// JOT_-prefixed var and its legacy equivalent are set, the JOT_-prefixed
// one wins.
func TestLoadJOTPrefixTakesPrecedenceOverLegacy(t *testing.T) {
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")
	t.Setenv("JOT_PORT", "3000")
	t.Setenv("PORT", "9000")

	cfg, err := Load()
	require.NoError(t, err)
	assert.Equal(t, 3000, cfg.Port)
}

// TestLoadLegacyInvalidValueErrorsMentionLegacyName verifies parse errors on
// a legacy var reference the legacy name the user actually set, not the new
// JOT_-prefixed one, so the error is actionable.
func TestLoadLegacyInvalidValueErrorsMentionLegacyName(t *testing.T) {
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")
	t.Setenv("PORT", "notanumber")

	_, err := Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid PORT value")
}
