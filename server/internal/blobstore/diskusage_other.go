//go:build !linux && !darwin

package blobstore

// DiskUsage is unsupported on this platform.
func (s *blobStore) DiskUsage() (free, total int64, err error) {
	return 0, 0, ErrDiskUsageUnsupported
}
