//go:build linux

package handlers

import (
	"fmt"
	"syscall"
)

// diskUsage reports the bytes available to unprivileged users and the total
// size of the filesystem holding path.
func diskUsage(path string) (free, total int64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, fmt.Errorf("statfs %s: %w", path, err)
	}
	// Linux counts f_blocks and f_bavail in f_frsize units (as statvfs and df
	// do); f_bsize is only the preferred I/O size and differs on e.g. FUSE
	// mounts. Kernels that leave f_frsize unset fall back to f_bsize.
	unit := int64(st.Frsize) //nolint:unconvert // int32 on 32-bit platforms
	if unit == 0 {
		unit = int64(st.Bsize) //nolint:unconvert // int32 on 32-bit platforms
	}
	return int64(st.Bavail) * unit, int64(st.Blocks) * unit, nil //nolint:gosec // block counts fit int64 on any real filesystem
}
