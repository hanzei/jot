package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

// Config holds all server configuration values.
type Config struct {
	Port              int
	DBPath            string
	StaticDir         string
	CORSAllowedOrigin string
	CookieSecure      bool
}

// Load reads configuration from environment variables, applying defaults
// for any values not set.
func Load() (*Config, error) {
	cfg := &Config{
		Port:              8080,
		DBPath:            "./jot.db",
		CORSAllowedOrigin: "http://localhost:5173",
		CookieSecure:      true,
	}

	if v := os.Getenv("PORT"); v != "" {
		p, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("invalid PORT value %q: must be a number", v)
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
		cfg.StaticDir = filepath.Clean(workDir + "/../webapp/build/")
	}

	if v := os.Getenv("CORS_ALLOWED_ORIGIN"); v != "" {
		cfg.CORSAllowedOrigin = v
	}

	if os.Getenv("COOKIE_SECURE") == "false" {
		cfg.CookieSecure = false
	}

	return cfg, nil
}
