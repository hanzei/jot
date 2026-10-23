//go:build darwin

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
	// On darwin f_bsize is the fundamental block size the counts are in.
	bsize := int64(st.Bsize)
	return int64(st.Bavail) * bsize, int64(st.Blocks) * bsize, nil //nolint:gosec // block counts fit int64 on any real filesystem
}
