package server

// Set at build time via -ldflags.
var (
	commit    = "unknown"
	buildTime = ""
	version   = "dev"
)

// Version returns the build-time version string.
func Version() string {
	return version
}
