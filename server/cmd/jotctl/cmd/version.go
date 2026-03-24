package cmd

import (
	"fmt"
	"runtime"
	"strings"

	"github.com/spf13/cobra"
)

// Set at build time via -ldflags.
var (
	commit    = "unknown"
	buildTime = ""
	version   = "dev"
)

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print version and build information",
	// No auth needed.
	PersistentPreRunE: func(_ *cobra.Command, _ []string) error { return nil },
	RunE:              runVersion,
}

type versionInfo struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildTime string `json:"build_time,omitempty"`
	GoVersion string `json:"go_version"`
}

func runVersion(_ *cobra.Command, _ []string) error {
	info := versionInfo{
		Version:   strings.TrimPrefix(version, "v"),
		Commit:    commit,
		BuildTime: buildTime,
		GoVersion: runtime.Version(),
	}

	if jsonOutput {
		return printJSON(info)
	}

	built := info.BuildTime
	if built == "" {
		built = "unknown"
	}
	fmt.Printf("jotctl %s (commit: %s, built: %s, %s)\n",
		info.Version, info.Commit, built, info.GoVersion)
	return nil
}
