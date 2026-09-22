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

func TestLoadDBDriver(t *testing.T) {
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")

	t.Run("default", func(t *testing.T) {
		t.Setenv("JOT_DB_DRIVER", "")
		cfg, err := Load()
		require.NoError(t, err)
		assert.Equal(t, "sqlite", cfg.DBDriver)
	})

	for _, driver := range []string{"sqlite", "postgres"} {
		t.Run(driver, func(t *testing.T) {
			t.Setenv("JOT_DB_DRIVER", driver)
			cfg, err := Load()
			require.NoError(t, err)
			assert.Equal(t, driver, cfg.DBDriver)
		})
	}

	// An unsupported driver must fail at config load with a clear message
	// rather than deep inside sql.Open or the migration runner.
	for _, v := range []string{"sqlite3", "postgresql", "mysql", "SQLite"} {
		t.Run("invalid "+v, func(t *testing.T) {
			t.Setenv("JOT_DB_DRIVER", v)
			_, err := Load()
			require.Error(t, err)
			assert.Contains(t, err.Error(), "invalid JOT_DB_DRIVER value")
			assert.Contains(t, err.Error(), "sqlite, postgres")
		})
	}
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

// TestLoadOTelVars verifies the renamed JOT_OTEL_* signal toggles and the
// spec-standard, still-unprefixed OTel SDK vars are both read correctly.
func TestLoadOTelVars(t *testing.T) {
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")
	t.Setenv("JOT_OTEL_TRACES_ENABLED", "true")
	t.Setenv("JOT_OTEL_METRICS_ENABLED", "true")
	t.Setenv("JOT_OTEL_LOGS_ENABLED", "true")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "localhost:4317")
	t.Setenv("OTEL_SERVICE_NAME", "custom-service")

	cfg, err := Load()
	require.NoError(t, err)

	assert.True(t, cfg.OTelTracesEnabled)
	assert.True(t, cfg.OTelMetricsEnabled)
	assert.True(t, cfg.OTelLogsEnabled)
	assert.Equal(t, "localhost:4317", cfg.OTelEndpoint)
	assert.Equal(t, "custom-service", cfg.OTelServiceName)
}

// TestLoadPprofEnabled covers the profiling switch, which is independent of
// JOT_METRICS_ENABLED.
func TestLoadPprofEnabled(t *testing.T) {
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")

	t.Run("defaults off", func(t *testing.T) {
		t.Setenv("JOT_PPROF_ENABLED", "")
		cfg, err := Load()
		require.NoError(t, err)
		assert.False(t, cfg.PprofEnabled)
	})

	t.Run("enabled without metrics", func(t *testing.T) {
		t.Setenv("JOT_PPROF_ENABLED", "true")
		t.Setenv("JOT_METRICS_ENABLED", "false")
		cfg, err := Load()
		require.NoError(t, err)
		assert.True(t, cfg.PprofEnabled)
		assert.False(t, cfg.MetricsEnabled)
	})

	t.Run("invalid value", func(t *testing.T) {
		t.Setenv("JOT_PPROF_ENABLED", "yes")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "JOT_PPROF_ENABLED")
	})
}

// setCoreOIDC sets the four required OIDC vars to valid values. Individual
// tests override or clear them to exercise the all-or-nothing validation.
func setCoreOIDC(t *testing.T) {
	t.Helper()
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")
	t.Setenv("JOT_OIDC_ISSUER", "https://idp.example.com")
	t.Setenv("JOT_OIDC_CLIENT_ID", "jot-client")
	t.Setenv("JOT_OIDC_CLIENT_SECRET", "s3cret")
	t.Setenv("JOT_OIDC_REDIRECT_URL", "https://jot.example.com/api/v1/auth/oidc/callback")
}

func TestLoadOIDCDefaults(t *testing.T) {
	t.Setenv("JOT_STATIC_DIR", "/tmp/static")

	cfg, err := Load()
	require.NoError(t, err)
	assert.False(t, cfg.OIDCEnabled)
	assert.True(t, cfg.LocalLoginEnabled, "local login defaults on when OIDC is not configured")
	assert.Empty(t, cfg.OIDCIssuer)
	assert.Empty(t, cfg.OIDCProviderName)
	assert.Empty(t, cfg.OIDCScopes)
}

func TestLoadOIDCEnabled(t *testing.T) {
	setCoreOIDC(t)

	t.Run("all core vars present applies defaults", func(t *testing.T) {
		cfg, err := Load()
		require.NoError(t, err)
		assert.True(t, cfg.OIDCEnabled)
		assert.Equal(t, "https://idp.example.com", cfg.OIDCIssuer)
		assert.Equal(t, "jot-client", cfg.OIDCClientID)
		assert.Equal(t, "SSO", cfg.OIDCProviderName)
		assert.Equal(t, []string{"openid", "profile", "email"}, cfg.OIDCScopes)
		assert.Equal(t, "preferred_username", cfg.OIDCUsernameClaim)
		assert.True(t, cfg.LocalLoginEnabled)
	})

	t.Run("optional vars override defaults", func(t *testing.T) {
		t.Setenv("JOT_OIDC_PROVIDER_NAME", "Keycloak")
		t.Setenv("JOT_OIDC_SCOPES", "openid email groups")
		t.Setenv("JOT_OIDC_USERNAME_CLAIM", "email")
		cfg, err := Load()
		require.NoError(t, err)
		assert.Equal(t, "Keycloak", cfg.OIDCProviderName)
		assert.Equal(t, []string{"openid", "email", "groups"}, cfg.OIDCScopes)
		assert.Equal(t, "email", cfg.OIDCUsernameClaim)
	})
}

func TestLoadOIDCScopesMustIncludeOpenID(t *testing.T) {
	setCoreOIDC(t)
	t.Setenv("JOT_OIDC_SCOPES", "profile email") // missing openid
	_, err := Load()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "JOT_OIDC_SCOPES")
	assert.Contains(t, err.Error(), "openid")
}

func TestLoadOIDCPartialConfigRejected(t *testing.T) {
	// Each core var missing in turn must fail with an all-or-nothing error that
	// names the missing var.
	for _, missing := range []string{
		"JOT_OIDC_ISSUER",
		"JOT_OIDC_CLIENT_ID",
		"JOT_OIDC_CLIENT_SECRET",
		"JOT_OIDC_REDIRECT_URL",
	} {
		t.Run(missing, func(t *testing.T) {
			setCoreOIDC(t)
			t.Setenv(missing, "")
			_, err := Load()
			require.Error(t, err)
			assert.Contains(t, err.Error(), missing)
		})
	}
}

func TestLoadOIDCInvalidURLs(t *testing.T) {
	t.Run("non-absolute issuer", func(t *testing.T) {
		setCoreOIDC(t)
		t.Setenv("JOT_OIDC_ISSUER", "idp.example.com")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "JOT_OIDC_ISSUER")
		assert.Contains(t, err.Error(), "absolute URL")
	})

	t.Run("non-absolute redirect URL", func(t *testing.T) {
		setCoreOIDC(t)
		t.Setenv("JOT_OIDC_REDIRECT_URL", "/callback")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "JOT_OIDC_REDIRECT_URL")
		assert.Contains(t, err.Error(), "absolute URL")
	})
}

func TestLoadOIDCIssuerRequiresHTTPS(t *testing.T) {
	t.Run("http issuer on a non-loopback host is rejected", func(t *testing.T) {
		setCoreOIDC(t)
		t.Setenv("JOT_OIDC_ISSUER", "http://idp.example.com")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "JOT_OIDC_ISSUER")
		assert.Contains(t, err.Error(), "https")
	})

	t.Run("http issuer on loopback is allowed for local development", func(t *testing.T) {
		setCoreOIDC(t)
		t.Setenv("JOT_OIDC_ISSUER", "http://127.0.0.1:5556/dex")
		cfg, err := Load()
		require.NoError(t, err)
		assert.Equal(t, "http://127.0.0.1:5556/dex", cfg.OIDCIssuer)
	})

	t.Run("http issuer on localhost is allowed", func(t *testing.T) {
		setCoreOIDC(t)
		t.Setenv("JOT_OIDC_ISSUER", "http://localhost:5556")
		_, err := Load()
		require.NoError(t, err)
	})
}

func TestLoadLocalLoginDisabledRequiresOIDC(t *testing.T) {
	t.Run("disabled without OIDC is rejected", func(t *testing.T) {
		t.Setenv("JOT_STATIC_DIR", "/tmp/static")
		t.Setenv("JOT_LOCAL_LOGIN_ENABLED", "false")
		_, err := Load()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "JOT_LOCAL_LOGIN_ENABLED")
	})

	t.Run("disabled with OIDC is allowed", func(t *testing.T) {
		setCoreOIDC(t)
		t.Setenv("JOT_LOCAL_LOGIN_ENABLED", "false")
		cfg, err := Load()
		require.NoError(t, err)
		assert.True(t, cfg.OIDCEnabled)
		assert.False(t, cfg.LocalLoginEnabled)
	})
}
