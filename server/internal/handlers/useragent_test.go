package handlers

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseUserAgent(t *testing.T) {
	tests := []struct {
		name    string
		ua      string
		browser string
		os      string
	}{
		{
			name:    "Chrome on Windows",
			ua:      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			browser: "Chrome",
			os:      "Windows",
		},
		{
			name:    "Firefox on Linux",
			ua:      "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
			browser: "Firefox",
			os:      "Linux",
		},
		{
			name:    "Safari on macOS",
			ua:      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
			browser: "Safari",
			os:      "macOS",
		},
		{
			name:    "Edge on Windows",
			ua:      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
			browser: "Edge",
			os:      "Windows",
		},
		{
			name:    "Chrome on Android",
			ua:      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.43 Mobile Safari/537.36",
			browser: "Chrome",
			os:      "Android",
		},
		{
			name:    "Safari on iOS",
			ua:      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
			browser: "Safari",
			os:      "iOS",
		},
		{
			name:    "Firefox on iOS",
			ua:      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/605.1.15",
			browser: "Firefox",
			os:      "iOS",
		},
		{
			name:    "Opera on Windows",
			ua:      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0",
			browser: "Opera",
			os:      "Windows",
		},
		{
			name:    "Chrome on ChromeOS",
			ua:      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			browser: "Chrome",
			os:      "ChromeOS",
		},
		{
			name:    "Jot Mobile on Android",
			ua:      "JotMobile/1.0 (Android)",
			browser: "Jot Mobile",
			os:      "Android",
		},
		{
			name:    "Jot Mobile on iOS",
			ua:      "JotMobile/1.0 (iOS)",
			browser: "Jot Mobile",
			os:      "iOS",
		},
		{
			name:    "empty string",
			ua:      "",
			browser: "Unknown",
			os:      "Unknown",
		},
		{
			name:    "Go HTTP client",
			ua:      "Go-http-client/1.1",
			browser: "Unknown",
			os:      "Unknown",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			parsed := parseUserAgent(tt.ua)
			assert.Equal(t, tt.browser, parsed.Browser)
			assert.Equal(t, tt.os, parsed.OS)
		})
	}
}
