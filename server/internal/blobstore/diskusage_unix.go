//go:build linux || darwin

package blobstore

import (
	"fmt"
	"syscall"
)

// DiskUsage reports the bytes available to unprivileged users and the total
// size of the filesystem holding the store.
func (s *blobStore) DiskUsage() (free, total int64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(s.root.Name(), &st); err != nil {
		return 0, 0, fmt.Errorf("statfs %s: %w", s.root.Name(), err)
	}
	unit := statfsUnit(&st)
	return int64(st.Bavail) * unit, int64(st.Blocks) * unit, nil //nolint:gosec // block counts fit int64 on any real filesystem
}
