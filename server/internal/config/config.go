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
	DBPath              string
	StaticDir           string
	CORSAllowedOrigin   string
	CookieSecure        bool
	RegistrationEnabled bool
}

// Load reads configuration from environment variables, applying defaults
// for any values not set.
func Load() (*Config, error) {
	cfg := &Config{
		Port:                8080,
		DBPath:              "./jot.db",
		CookieSecure:        true,
		RegistrationEnabled: true,
	}

	if v := os.Getenv("PORT"); v != "" {
		p, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("invalid PORT value %q: must be a number", v)
		}
		if p < 1 || p > 65535 {
			return nil, fmt.Errorf("invalid PORT value %d: must be between 1 and 65535", p)
		}
		cfg.Port = p
	}

	if v := os.Getenv("DB_PATH"); v != "" {
		cfg.DBPath = v
	}

	if v := os.Getenv("STATIC_DIR"); v != "" {
		cfg.StaticDir = filepath.Clean(v)
	} else {
		workDir, err := os.Getwd()
		if err != nil {
			return nil, fmt.Errorf("get working directory: %w", err)
		}
		cfg.StaticDir = filepath.Join(workDir, "..", "webapp", "build")
	}

	cfg.CORSAllowedOrigin = os.Getenv("CORS_ALLOWED_ORIGIN")

	switch os.Getenv("COOKIE_SECURE") {
	case "false":
		cfg.CookieSecure = false
	case "", "true":
		// default already set to true
	default:
		return nil, fmt.Errorf("invalid COOKIE_SECURE value %q: must be \"true\" or \"false\"", os.Getenv("COOKIE_SECURE"))
	}

	if os.Getenv("REGISTRATION_ENABLED") == "false" {
		cfg.RegistrationEnabled = false
	}

	return cfg, nil
}
