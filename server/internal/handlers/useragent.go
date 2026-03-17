package handlers

import "strings"

type ParsedUserAgent struct {
	Browser string `json:"browser"`
	OS      string `json:"os"`
}

func parseUserAgent(ua string) ParsedUserAgent {
	return ParsedUserAgent{
		Browser: parseBrowser(ua),
		OS:      parseOS(ua),
	}
}

func parseBrowser(ua string) string {
	switch {
	case strings.Contains(ua, "Edg/") || strings.Contains(ua, "EdgA/") || strings.Contains(ua, "EdgiOS/"):
		return "Edge"
	case strings.Contains(ua, "OPR/") || strings.Contains(ua, "Opera"):
		return "Opera"
	case strings.Contains(ua, "Vivaldi/"):
		return "Vivaldi"
	case strings.Contains(ua, "Brave"):
		return "Brave"
	case strings.Contains(ua, "YaBrowser/"):
		return "Yandex"
	case strings.Contains(ua, "SamsungBrowser/"):
		return "Samsung Internet"
	case strings.Contains(ua, "Firefox/") || strings.Contains(ua, "FxiOS/"):
		return "Firefox"
	case strings.Contains(ua, "CriOS/"):
		return "Chrome"
	case strings.Contains(ua, "Chrome/") && strings.Contains(ua, "Safari/"):
		return "Chrome"
	case strings.Contains(ua, "Safari/") && !strings.Contains(ua, "Chrome/"):
		return "Safari"
	case strings.Contains(ua, "MSIE ") || strings.Contains(ua, "Trident/"):
		return "Internet Explorer"
	default:
		return "Unknown"
	}
}

func parseOS(ua string) string {
	switch {
	case strings.Contains(ua, "iPhone") || strings.Contains(ua, "iPad") || strings.Contains(ua, "iPod"):
		return "iOS"
	case strings.Contains(ua, "Android"):
		return "Android"
	case strings.Contains(ua, "Windows"):
		return "Windows"
	case strings.Contains(ua, "Mac OS X") || strings.Contains(ua, "Macintosh"):
		return "macOS"
	case strings.Contains(ua, "CrOS"):
		return "ChromeOS"
	case strings.Contains(ua, "Linux"):
		return "Linux"
	default:
		return "Unknown"
	}
}
