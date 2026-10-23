//go:build !linux && !darwin

package handlers

// diskUsage is unsupported on this platform; the admin stats report the
// upload volume's usage as unknown.
func diskUsage(string) (free, total int64, err error) {
	return 0, 0, errDiskUsageUnsupported
}
