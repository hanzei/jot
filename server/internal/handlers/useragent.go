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

type browserRule struct {
	markers []string
	name    string
}

var browserRules = []browserRule{
	{markers: []string{"Edg/", "EdgA/", "EdgiOS/"}, name: "Edge"},
	{markers: []string{"OPR/", "Opera"}, name: "Opera"},
	{markers: []string{"Vivaldi/"}, name: "Vivaldi"},
	{markers: []string{"Brave"}, name: "Brave"},
	{markers: []string{"YaBrowser/"}, name: "Yandex"},
	{markers: []string{"SamsungBrowser/"}, name: "Samsung Internet"},
	{markers: []string{"Firefox/", "FxiOS/"}, name: "Firefox"},
	{markers: []string{"CriOS/"}, name: "Chrome"},
	{markers: []string{"MSIE ", "Trident/"}, name: "Internet Explorer"},
}

func parseBrowser(ua string) string {
	for _, rule := range browserRules {
		for _, marker := range rule.markers {
			if strings.Contains(ua, marker) {
				return rule.name
			}
		}
	}

	if strings.Contains(ua, "Chrome/") && strings.Contains(ua, "Safari/") {
		return "Chrome"
	}
	if strings.Contains(ua, "Safari/") {
		return "Safari"
	}

	return "Unknown"
}

type osRule struct {
	markers []string
	name    string
}

var osRules = []osRule{
	{markers: []string{"iPhone", "iPad", "iPod"}, name: "iOS"},
	{markers: []string{"Android"}, name: "Android"},
	{markers: []string{"Windows"}, name: "Windows"},
	{markers: []string{"Mac OS X", "Macintosh"}, name: "macOS"},
	{markers: []string{"CrOS"}, name: "ChromeOS"},
	{markers: []string{"Linux"}, name: "Linux"},
}

func parseOS(ua string) string {
	for _, rule := range osRules {
		for _, marker := range rule.markers {
			if strings.Contains(ua, marker) {
				return rule.name
			}
		}
	}
	return "Unknown"
}
