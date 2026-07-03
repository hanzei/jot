package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
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
	OTelEnabled         bool
	OTelEndpoint        string
	OTelServiceName     string
	OTelInsecure        bool
	OTelTracesEnabled   bool
	OTelMetricsEnabled  bool
	OTelLogsEnabled     bool
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

// Load reads configuration from environment variables, applying defaults
// for any values not set.
func Load() (*Config, error) {
	cfg := &Config{
		MetricsHost:         "127.0.0.1",
		DBDriver:            "sqlite",
		DBDSN:               "./jot.db",
		UploadDir:           "./uploads",
		CookieSecure:        true,
		RegistrationEnabled: true,
		OTelServiceName:     "jot",
	}

	port, err := parseIntRangeEnv("PORT", 8080, 1, 65535)
	if err != nil {
		return nil, err
	}
	cfg.Port = port

	metricsPort, err := parseIntRangeEnv("METRICS_PORT", 8081, 1, 65535)
	if err != nil {
		return nil, err
	}
	cfg.MetricsPort = metricsPort

	if v := os.Getenv("METRICS_HOST"); v != "" {
		cfg.MetricsHost = v
	}

	metricsEnabled, err := parseBoolEnv("METRICS_ENABLED", false)
	if err != nil {
		return nil, err
	}
	cfg.MetricsEnabled = metricsEnabled

	if v := os.Getenv("DB_DRIVER"); v != "" {
		cfg.DBDriver = v
	}
	if v := os.Getenv("DB_DSN"); v != "" {
		cfg.DBDSN = v
	}

	if v := os.Getenv("UPLOAD_DIR"); v != "" {
		cfg.UploadDir = filepath.Clean(v)
	}

	// Keep default and bounds in sync with shared/src/constants.ts UPLOAD_MAX_BYTES.
	uploadMaxBytes, err := parseIntRangeEnv("UPLOAD_MAX_BYTES", 25<<20, 1<<20, 500<<20)
	if err != nil {
		return nil, err
	}
	cfg.UploadMaxBytes = uploadMaxBytes

	if v := os.Getenv("STATIC_DIR"); v != "" {
		cfg.StaticDir = filepath.Clean(v)
	} else {
		workDir, wdErr := os.Getwd()
		if wdErr != nil {
			return nil, fmt.Errorf("get working directory: %w", wdErr)
		}
		cfg.StaticDir = filepath.Join(workDir, "..", "webapp", "build")
	}

	cfg.CORSAllowedOrigin = os.Getenv("CORS_ALLOWED_ORIGIN")

	cookieSecure, err := parseBoolEnv("COOKIE_SECURE", true)
	if err != nil {
		return nil, err
	}
	cfg.CookieSecure = cookieSecure

	registrationEnabled, err := parseBoolEnv("REGISTRATION_ENABLED", true)
	if err != nil {
		return nil, err
	}
	cfg.RegistrationEnabled = registrationEnabled

	passwordMinLength, err := parseIntRangeEnv("PASSWORD_MIN_LENGTH", 10, 1, 72)
	if err != nil {
		return nil, err
	}
	cfg.PasswordMinLength = passwordMinLength

	otelEnabled, err := parseBoolEnv("OTEL_ENABLED", false)
	if err != nil {
		return nil, err
	}
	cfg.OTelEnabled = otelEnabled

	cfg.OTelEndpoint = os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")

	if v := os.Getenv("OTEL_SERVICE_NAME"); v != "" {
		cfg.OTelServiceName = v
	}

	otelInsecure, err := parseBoolEnv("OTEL_EXPORTER_OTLP_INSECURE", false)
	if err != nil {
		return nil, err
	}
	cfg.OTelInsecure = otelInsecure

	otelTracesEnabled, err := parseBoolEnv("OTEL_TRACES_ENABLED", false)
	if err != nil {
		return nil, err
	}
	cfg.OTelTracesEnabled = otelTracesEnabled

	// Metrics and logs default to true (unlike traces) to preserve pre-existing
	// export behavior: collectors missing a traces pipeline are common, but
	// ones missing metrics/logs pipelines are not, so opting those out by
	// default would silently drop data most users still want.
	otelMetricsEnabled, err := parseBoolEnv("OTEL_METRICS_ENABLED", true)
	if err != nil {
		return nil, err
	}
	cfg.OTelMetricsEnabled = otelMetricsEnabled

	otelLogsEnabled, err := parseBoolEnv("OTEL_LOGS_ENABLED", true)
	if err != nil {
		return nil, err
	}
	cfg.OTelLogsEnabled = otelLogsEnabled

	return cfg, nil
}
