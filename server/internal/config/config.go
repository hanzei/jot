package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Config holds all server configuration values.
type Config struct {
	Port                int
	MetricsEnabled      bool
	MetricsPort         int
	MetricsHost         string
	DBPath              string
	StaticDir           string
	CORSAllowedOrigin   string
	CookieSecure        bool
	RegistrationEnabled bool
	PasswordMinLength   int
	OTelEnabled         bool
	OTelEndpoint        string
	OTelServiceName     string
	OTelInsecure        bool
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
		DBPath:              "./jot.db",
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

	if v := os.Getenv("DB_PATH"); v != "" {
		cfg.DBPath = v
	}

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

	if os.Getenv("REGISTRATION_ENABLED") == "false" {
		cfg.RegistrationEnabled = false
	}

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

	// Normalize the OTLP endpoint to a full URL with scheme so the OTel SDK
	// can parse it correctly. Bare "host:port" values (no scheme) are common
	// for gRPC but cause url.Parse to fail inside the SDK. Adding "http://"
	// is safe: the gRPC transport ignores the scheme and uses the Insecure
	// flag to control TLS.
	if v := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"); v != "" {
		if !strings.Contains(v, "://") {
			v = "http://" + v
		}
		cfg.OTelEndpoint = v
	}

	if v := os.Getenv("OTEL_SERVICE_NAME"); v != "" {
		cfg.OTelServiceName = v
	}

	otelInsecure, err := parseBoolEnv("OTEL_EXPORTER_OTLP_INSECURE", false)
	if err != nil {
		return nil, err
	}
	cfg.OTelInsecure = otelInsecure

	return cfg, nil
}
