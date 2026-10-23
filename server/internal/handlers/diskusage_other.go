//go:build !linux && !darwin

package handlers

import "errors"

// diskUsage is unsupported on this platform; the admin stats report the
// upload volume's usage as unknown.
func diskUsage(string) (free, total int64, err error) {
	return 0, 0, errors.New("disk usage not supported on this platform")
}
