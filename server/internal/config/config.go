package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/sirupsen/logrus"
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

// resolveEnv reads the JOT_-prefixed env var name, falling back to the
// deprecated legacyName (its pre-JOT_-prefix equivalent) when name is unset.
// A fallback read logs a deprecation warning; legacy names are planned for
// removal at the v1.0 stable release. It returns the resolved value along
// with whichever name it was actually read from, so callers can report
// parse errors against the variable the user actually set.
func resolveEnv(name, legacyName string) (value, usedName string) {
	if v := os.Getenv(name); v != "" {
		return v, name
	}
	if v := os.Getenv(legacyName); v != "" {
		logrus.Warnf("%s is deprecated and will be removed at the v1.0 stable release; use %s instead", legacyName, name)
		return v, legacyName
	}
	return "", name
}

// parseBoolEnv parses a raw env var value that must be "true", "false", or
// empty. It returns defaultVal when value is empty. name is used only to
// produce a descriptive error message.
func parseBoolEnv(name, value string, defaultVal bool) (bool, error) {
	switch value {
	case "":
		return defaultVal, nil
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, fmt.Errorf("invalid %s value %q: must be \"true\" or \"false\"", name, value)
	}
}

// parseIntRangeEnv parses a raw env var value as an integer and validates it
// is within [min, max]. It returns defaultVal when value is empty. name is
// used only to produce a descriptive error message.
func parseIntRangeEnv(name, value string, defaultVal, min, max int) (int, error) {
	if value == "" {
		return defaultVal, nil
	}
	n, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("invalid %s value %q: must be a number", name, value)
	}
	if n < min || n > max {
		return 0, fmt.Errorf("invalid %s value %d: must be between %d and %d", name, n, min, max)
	}
	return n, nil
}

// Load reads configuration from environment variables, applying defaults
// for any values not set.
//
//nolint:gocognit,gocyclo // A flat sequence of independent "resolve env var,
// parse, assign field, bail on error" steps; splitting it up would trade this
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

	portVal, portName := resolveEnv("JOT_PORT", "PORT")
	port, err := parseIntRangeEnv(portName, portVal, 8080, 1, 65535)
	if err != nil {
		return nil, err
	}
	cfg.Port = port

	metricsPortVal, metricsPortName := resolveEnv("JOT_METRICS_PORT", "METRICS_PORT")
	metricsPort, err := parseIntRangeEnv(metricsPortName, metricsPortVal, 8081, 1, 65535)
	if err != nil {
		return nil, err
	}
	cfg.MetricsPort = metricsPort

	if v, _ := resolveEnv("JOT_METRICS_HOST", "METRICS_HOST"); v != "" {
		cfg.MetricsHost = v
	}

	metricsEnabledVal, metricsEnabledName := resolveEnv("JOT_METRICS_ENABLED", "METRICS_ENABLED")
	metricsEnabled, err := parseBoolEnv(metricsEnabledName, metricsEnabledVal, false)
	if err != nil {
		return nil, err
	}
	cfg.MetricsEnabled = metricsEnabled

	if v, _ := resolveEnv("JOT_DB_DRIVER", "DB_DRIVER"); v != "" {
		cfg.DBDriver = v
	}
	if v, _ := resolveEnv("JOT_DB_DSN", "DB_DSN"); v != "" {
		cfg.DBDSN = v
	}

	if v, _ := resolveEnv("JOT_UPLOAD_DIR", "UPLOAD_DIR"); v != "" {
		cfg.UploadDir = filepath.Clean(v)
	}

	// Keep default and bounds in sync with shared/src/constants.ts UPLOAD_MAX_BYTES.
	uploadMaxBytesVal, uploadMaxBytesName := resolveEnv("JOT_UPLOAD_MAX_BYTES", "UPLOAD_MAX_BYTES")
	uploadMaxBytes, err := parseIntRangeEnv(uploadMaxBytesName, uploadMaxBytesVal, 25<<20, 1<<20, 500<<20)
	if err != nil {
		return nil, err
	}
	cfg.UploadMaxBytes = uploadMaxBytes

	if v, _ := resolveEnv("JOT_STATIC_DIR", "STATIC_DIR"); v != "" {
		cfg.StaticDir = filepath.Clean(v)
	} else {
		workDir, wdErr := os.Getwd()
		if wdErr != nil {
			return nil, fmt.Errorf("get working directory: %w", wdErr)
		}
		cfg.StaticDir = filepath.Join(workDir, "..", "webapp", "build")
	}

	cfg.CORSAllowedOrigin, _ = resolveEnv("JOT_CORS_ALLOWED_ORIGIN", "CORS_ALLOWED_ORIGIN")

	cookieSecureVal, cookieSecureName := resolveEnv("JOT_COOKIE_SECURE", "COOKIE_SECURE")
	cookieSecure, err := parseBoolEnv(cookieSecureName, cookieSecureVal, true)
	if err != nil {
		return nil, err
	}
	cfg.CookieSecure = cookieSecure

	registrationEnabledVal, registrationEnabledName := resolveEnv("JOT_REGISTRATION_ENABLED", "REGISTRATION_ENABLED")
	registrationEnabled, err := parseBoolEnv(registrationEnabledName, registrationEnabledVal, true)
	if err != nil {
		return nil, err
	}
	cfg.RegistrationEnabled = registrationEnabled

	passwordMinLengthVal, passwordMinLengthName := resolveEnv("JOT_PASSWORD_MIN_LENGTH", "PASSWORD_MIN_LENGTH")
	passwordMinLength, err := parseIntRangeEnv(passwordMinLengthName, passwordMinLengthVal, 10, 1, 72)
	if err != nil {
		return nil, err
	}
	cfg.PasswordMinLength = passwordMinLength

	// OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_INSECURE, and
	// OTEL_SERVICE_NAME are spec-standard OpenTelemetry SDK env vars — they
	// are intentionally NOT prefixed with JOT_ so the OTel SDK's own
	// conventions keep working as documented upstream.
	cfg.OTelEndpoint = os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")

	if v := os.Getenv("OTEL_SERVICE_NAME"); v != "" {
		cfg.OTelServiceName = v
	}

	otelInsecure, err := parseBoolEnv("OTEL_EXPORTER_OTLP_INSECURE", os.Getenv("OTEL_EXPORTER_OTLP_INSECURE"), false)
	if err != nil {
		return nil, err
	}
	cfg.OTelInsecure = otelInsecure

	// Unlike the vars above, these three signal toggles are jot-specific
	// (there is no such standard OTel env var), so they get the JOT_ prefix
	// like the rest of the app's own config.
	otelTracesEnabledVal, otelTracesEnabledName := resolveEnv("JOT_OTEL_TRACES_ENABLED", "OTEL_TRACES_ENABLED")
	otelTracesEnabled, err := parseBoolEnv(otelTracesEnabledName, otelTracesEnabledVal, false)
	if err != nil {
		return nil, err
	}
	cfg.OTelTracesEnabled = otelTracesEnabled

	// There is no single OTEL_ENABLED switch: OTel setup runs whenever at
	// least one of traces/metrics/logs is enabled, so each signal is opt-in
	// independently and all three default to false.
	otelMetricsEnabledVal, otelMetricsEnabledName := resolveEnv("JOT_OTEL_METRICS_ENABLED", "OTEL_METRICS_ENABLED")
	otelMetricsEnabled, err := parseBoolEnv(otelMetricsEnabledName, otelMetricsEnabledVal, false)
	if err != nil {
		return nil, err
	}
	cfg.OTelMetricsEnabled = otelMetricsEnabled

	otelLogsEnabledVal, otelLogsEnabledName := resolveEnv("JOT_OTEL_LOGS_ENABLED", "OTEL_LOGS_ENABLED")
	otelLogsEnabled, err := parseBoolEnv(otelLogsEnabledName, otelLogsEnabledVal, false)
	if err != nil {
		return nil, err
	}
	cfg.OTelLogsEnabled = otelLogsEnabled

	rateLimitEnabledVal, rateLimitEnabledName := resolveEnv("JOT_RATE_LIMIT_ENABLED", "RATE_LIMIT_ENABLED")
	rateLimitEnabled, err := parseBoolEnv(rateLimitEnabledName, rateLimitEnabledVal, true)
	if err != nil {
		return nil, err
	}
	cfg.RateLimitEnabled = rateLimitEnabled

	rateLimitPerMinuteVal, rateLimitPerMinuteName := resolveEnv("JOT_RATE_LIMIT_PER_MINUTE", "RATE_LIMIT_PER_MINUTE")
	rateLimitPerMinute, err := parseIntRangeEnv(rateLimitPerMinuteName, rateLimitPerMinuteVal, 300, 1, 1_000_000)
	if err != nil {
		return nil, err
	}
	cfg.RateLimitPerMinute = rateLimitPerMinute

	rateLimitAuthPerMinuteVal, rateLimitAuthPerMinuteName := resolveEnv("JOT_RATE_LIMIT_AUTH_PER_MINUTE", "RATE_LIMIT_AUTH_PER_MINUTE")
	rateLimitAuthPerMinute, err := parseIntRangeEnv(rateLimitAuthPerMinuteName, rateLimitAuthPerMinuteVal, 20, 1, 1_000_000)
	if err != nil {
		return nil, err
	}
	cfg.RateLimitAuthPerMinute = rateLimitAuthPerMinute

	rateLimitExpensivePerMinuteVal, rateLimitExpensivePerMinuteName := resolveEnv("JOT_RATE_LIMIT_EXPENSIVE_PER_MINUTE", "RATE_LIMIT_EXPENSIVE_PER_MINUTE")
	rateLimitExpensivePerMinute, err := parseIntRangeEnv(rateLimitExpensivePerMinuteName, rateLimitExpensivePerMinuteVal, 20, 1, 1_000_000)
	if err != nil {
		return nil, err
	}
	cfg.RateLimitExpensivePerMinute = rateLimitExpensivePerMinute

	return cfg, nil
}
