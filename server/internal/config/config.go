package config

import (
	"fmt"
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
//nolint:gocognit,gocyclo // A flat sequence of independent "parse env var,
// assign field, bail on error" steps; splitting it up would trade this
// straight-line readability for indirection without reducing actual complexity.
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

	return cfg, nil
}
