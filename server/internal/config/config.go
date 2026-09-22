package config

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// Config holds all server configuration values.
type Config struct {
	Port                int
	MetricsEnabled      bool
	MetricsPort         int
	MetricsHost         string
	PprofEnabled        bool
	DBDriver            string
	DBDSN               string
	StaticDir           string
	UploadDir           string
	UploadMaxBytes      int
	CORSAllowedOrigin   string
	CookieSecure        bool
	RegistrationEnabled bool
	PasswordMinLength   int
	OTelEndpoint        string
	OTelServiceName     string
	OTelInsecure        bool
	OTelTracesEnabled   bool
	OTelMetricsEnabled  bool
	OTelLogsEnabled     bool

	RateLimitEnabled            bool
	RateLimitPerMinute          int
	RateLimitAuthPerMinute      int
	RateLimitExpensivePerMinute int

	// OIDC / SSO. OIDCEnabled is derived: it is true when the four core vars
	// are set. When it is false every other OIDC field is empty and LocalLogin
	// is forced on, so a deployment that sets no JOT_OIDC_* vars behaves exactly
	// as before.
	OIDCEnabled       bool
	OIDCIssuer        string
	OIDCClientID      string
	OIDCClientSecret  string
	OIDCRedirectURL   string
	OIDCProviderName  string
	OIDCScopes        []string
	OIDCUsernameClaim string
	LocalLoginEnabled bool
}

// parseBoolEnv reads an environment variable that must be "true", "false", or
// absent. It returns defaultVal when the variable is not set.
func parseBoolEnv(name string, defaultVal bool) (bool, error) {
	switch os.Getenv(name) {
	case "":
		return defaultVal, nil
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, fmt.Errorf("invalid %s value %q: must be \"true\" or \"false\"", name, os.Getenv(name))
	}
}

// parseIntRangeEnv reads an integer environment variable and validates it is
// within [min, max]. Returns defaultVal when the variable is not set.
func parseIntRangeEnv(name string, defaultVal, min, max int) (int, error) {
	v := os.Getenv(name)
	if v == "" {
		return defaultVal, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("invalid %s value %q: must be a number", name, v)
	}
	if n < min || n > max {
		return 0, fmt.Errorf("invalid %s value %d: must be between %d and %d", name, n, min, max)
	}
	return n, nil
}

// parseEnumEnv reads a string environment variable and validates it is one of
// allowed. Returns defaultVal when the variable is not set.
func parseEnumEnv(name, defaultVal string, allowed ...string) (string, error) {
	v := os.Getenv(name)
	if v == "" {
		return defaultVal, nil
	}
	if slices.Contains(allowed, v) {
		return v, nil
	}
	return "", fmt.Errorf("invalid %s value %q: must be one of %s", name, v, strings.Join(allowed, ", "))
}

// Load reads configuration from environment variables, applying defaults
// for any values not set.
//
// assign field, bail on error" steps; splitting it up would trade this
// straight-line readability for indirection without reducing actual complexity.
//
//nolint:gocognit,gocyclo // A flat sequence of independent "parse env var,
func Load() (*Config, error) {
	cfg := &Config{
		MetricsHost:         "127.0.0.1",
		DBDriver:            "sqlite",
		DBDSN:               "./jot.db",
		UploadDir:           "./uploads",
		CookieSecure:        true,
		RegistrationEnabled: true,
		OTelServiceName:     "jot",
		RateLimitEnabled:    true,
	}

	port, err := parseIntRangeEnv("JOT_PORT", 8080, 1, 65535)
	if err != nil {
		return nil, err
	}
	cfg.Port = port

	metricsPort, err := parseIntRangeEnv("JOT_METRICS_PORT", 8081, 1, 65535)
	if err != nil {
		return nil, err
	}
	cfg.MetricsPort = metricsPort

	if v := os.Getenv("JOT_METRICS_HOST"); v != "" {
		cfg.MetricsHost = v
	}

	metricsEnabled, err := parseBoolEnv("JOT_METRICS_ENABLED", false)
	if err != nil {
		return nil, err
	}
	cfg.MetricsEnabled = metricsEnabled

	// Profiling shares the metrics listener (and therefore MetricsHost /
	// MetricsPort) but has its own switch, so either can run without the other.
	pprofEnabled, err := parseBoolEnv("JOT_PPROF_ENABLED", false)
	if err != nil {
		return nil, err
	}
	cfg.PprofEnabled = pprofEnabled

	// Keep the allowed set in sync with the drivers supported by
	// internal/database.New and internal/database/dialect.
	dbDriver, err := parseEnumEnv("JOT_DB_DRIVER", cfg.DBDriver, "sqlite", "postgres")
	if err != nil {
		return nil, err
	}
	cfg.DBDriver = dbDriver

	if v := os.Getenv("JOT_DB_DSN"); v != "" {
		cfg.DBDSN = v
	}

	if v := os.Getenv("JOT_UPLOAD_DIR"); v != "" {
		cfg.UploadDir = filepath.Clean(v)
	}

	// Keep default and bounds in sync with shared/src/constants.ts UPLOAD_MAX_BYTES.
	uploadMaxBytes, err := parseIntRangeEnv("JOT_UPLOAD_MAX_BYTES", 25<<20, 1<<20, 500<<20)
	if err != nil {
		return nil, err
	}
	cfg.UploadMaxBytes = uploadMaxBytes

	if v := os.Getenv("JOT_STATIC_DIR"); v != "" {
		cfg.StaticDir = filepath.Clean(v)
	} else {
		workDir, wdErr := os.Getwd()
		if wdErr != nil {
			return nil, fmt.Errorf("get working directory: %w", wdErr)
		}
		cfg.StaticDir = filepath.Join(workDir, "..", "webapp", "build")
	}

	cfg.CORSAllowedOrigin = os.Getenv("JOT_CORS_ALLOWED_ORIGIN")

	cookieSecure, err := parseBoolEnv("JOT_COOKIE_SECURE", true)
	if err != nil {
		return nil, err
	}
	cfg.CookieSecure = cookieSecure

	registrationEnabled, err := parseBoolEnv("JOT_REGISTRATION_ENABLED", true)
	if err != nil {
		return nil, err
	}
	cfg.RegistrationEnabled = registrationEnabled

	passwordMinLength, err := parseIntRangeEnv("JOT_PASSWORD_MIN_LENGTH", 10, 1, 72)
	if err != nil {
		return nil, err
	}
	cfg.PasswordMinLength = passwordMinLength

	// Spec-standard OpenTelemetry SDK vars stay unprefixed; the SDK expects these exact names.
	cfg.OTelEndpoint = os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")

	if v := os.Getenv("OTEL_SERVICE_NAME"); v != "" {
		cfg.OTelServiceName = v
	}

	otelInsecure, err := parseBoolEnv("OTEL_EXPORTER_OTLP_INSECURE", false)
	if err != nil {
		return nil, err
	}
	cfg.OTelInsecure = otelInsecure

	// Jot-specific signal toggles (no standard OTel equivalent) get the JOT_ prefix.
	otelTracesEnabled, err := parseBoolEnv("JOT_OTEL_TRACES_ENABLED", false)
	if err != nil {
		return nil, err
	}
	cfg.OTelTracesEnabled = otelTracesEnabled

	// There is no single OTEL_ENABLED switch: OTel setup runs whenever at
	// least one of traces/metrics/logs is enabled, so each signal is opt-in
	// independently and all three default to false.
	otelMetricsEnabled, err := parseBoolEnv("JOT_OTEL_METRICS_ENABLED", false)
	if err != nil {
		return nil, err
	}
	cfg.OTelMetricsEnabled = otelMetricsEnabled

	otelLogsEnabled, err := parseBoolEnv("JOT_OTEL_LOGS_ENABLED", false)
	if err != nil {
		return nil, err
	}
	cfg.OTelLogsEnabled = otelLogsEnabled

	rateLimitEnabled, err := parseBoolEnv("JOT_RATE_LIMIT_ENABLED", true)
	if err != nil {
		return nil, err
	}
	cfg.RateLimitEnabled = rateLimitEnabled

	rateLimitPerMinute, err := parseIntRangeEnv("JOT_RATE_LIMIT_PER_MINUTE", 300, 1, 1_000_000)
	if err != nil {
		return nil, err
	}
	cfg.RateLimitPerMinute = rateLimitPerMinute

	rateLimitAuthPerMinute, err := parseIntRangeEnv("JOT_RATE_LIMIT_AUTH_PER_MINUTE", 20, 1, 1_000_000)
	if err != nil {
		return nil, err
	}
	cfg.RateLimitAuthPerMinute = rateLimitAuthPerMinute

	rateLimitExpensivePerMinute, err := parseIntRangeEnv("JOT_RATE_LIMIT_EXPENSIVE_PER_MINUTE", 20, 1, 1_000_000)
	if err != nil {
		return nil, err
	}
	cfg.RateLimitExpensivePerMinute = rateLimitExpensivePerMinute

	if err := loadOIDC(cfg); err != nil {
		return nil, err
	}

	return cfg, nil
}

// loadOIDC reads and validates the JOT_OIDC_* and JOT_LOCAL_LOGIN_ENABLED
// settings. OIDC is all-or-nothing: "enabled" means any of the four core vars
// (issuer, client id, client secret, redirect URL) is set, and when it is, all
// four must be present. The issuer and redirect URL must parse as absolute
// URLs. Local login defaults on; disabling it is only allowed when OIDC is
// enabled, since otherwise the deployment could authenticate no one.
func loadOIDC(cfg *Config) error {
	cfg.OIDCIssuer = os.Getenv("JOT_OIDC_ISSUER")
	cfg.OIDCClientID = os.Getenv("JOT_OIDC_CLIENT_ID")
	cfg.OIDCClientSecret = os.Getenv("JOT_OIDC_CLIENT_SECRET")
	cfg.OIDCRedirectURL = os.Getenv("JOT_OIDC_REDIRECT_URL")

	// "enabled" is defined as any core var set, so a partial configuration is
	// reported as a missing-var error rather than silently treated as disabled.
	core := map[string]string{
		"JOT_OIDC_ISSUER":        cfg.OIDCIssuer,
		"JOT_OIDC_CLIENT_ID":     cfg.OIDCClientID,
		"JOT_OIDC_CLIENT_SECRET": cfg.OIDCClientSecret,
		"JOT_OIDC_REDIRECT_URL":  cfg.OIDCRedirectURL,
	}
	anySet := false
	for _, v := range core {
		if v != "" {
			anySet = true
			break
		}
	}
	cfg.OIDCEnabled = anySet

	localLoginEnabled, err := parseBoolEnv("JOT_LOCAL_LOGIN_ENABLED", true)
	if err != nil {
		return err
	}
	cfg.LocalLoginEnabled = localLoginEnabled

	if !cfg.OIDCEnabled {
		if !cfg.LocalLoginEnabled {
			return fmt.Errorf("JOT_LOCAL_LOGIN_ENABLED=false requires OIDC to be configured, otherwise no user could authenticate")
		}
		return nil
	}

	// Sort the missing names for a stable, testable error message.
	var missing []string
	for name, v := range core {
		if v == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		slices.Sort(missing)
		return fmt.Errorf("OIDC is enabled but these required variables are missing: %s", strings.Join(missing, ", "))
	}

	if err := requireAbsoluteURL("JOT_OIDC_ISSUER", cfg.OIDCIssuer); err != nil {
		return err
	}
	if err := requireAbsoluteURL("JOT_OIDC_REDIRECT_URL", cfg.OIDCRedirectURL); err != nil {
		return err
	}

	cfg.OIDCProviderName = os.Getenv("JOT_OIDC_PROVIDER_NAME")
	if cfg.OIDCProviderName == "" {
		cfg.OIDCProviderName = "SSO"
	}

	scopes := os.Getenv("JOT_OIDC_SCOPES")
	if scopes == "" {
		scopes = "openid profile email"
	}
	cfg.OIDCScopes = strings.Fields(scopes)

	// "openid" is what makes this an OpenID Connect flow: without it the token
	// endpoint returns no id_token and every login fails at runtime (see
	// internal/oidc.Provider.Verify). Reject it at startup instead, matching how
	// the other OIDC settings are validated here.
	if !slices.Contains(cfg.OIDCScopes, "openid") {
		return fmt.Errorf("invalid JOT_OIDC_SCOPES value %q: must include the \"openid\" scope", scopes)
	}

	cfg.OIDCUsernameClaim = os.Getenv("JOT_OIDC_USERNAME_CLAIM")
	if cfg.OIDCUsernameClaim == "" {
		cfg.OIDCUsernameClaim = "preferred_username"
	}

	return nil
}

// requireAbsoluteURL fails unless v parses as an absolute URL (scheme + host),
// matching how the package rejects other malformed settings at startup.
func requireAbsoluteURL(name, v string) error {
	u, err := url.Parse(v)
	if err != nil {
		return fmt.Errorf("invalid %s value %q: %w", name, v, err)
	}
	if !u.IsAbs() || u.Host == "" {
		return fmt.Errorf("invalid %s value %q: must be an absolute URL", name, v)
	}
	return nil
}
