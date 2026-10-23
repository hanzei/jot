package blobstore

import "syscall"

// statfsUnit is the size of the blocks statfs counts in. Linux counts
// f_blocks and f_bavail in f_frsize units (as statvfs and df do); f_bsize is
// only the preferred I/O size and differs on e.g. FUSE mounts. Kernels that
// leave f_frsize unset fall back to f_bsize.
func statfsUnit(st *syscall.Statfs_t) int64 {
	if st.Frsize != 0 {
		return int64(st.Frsize) //nolint:unconvert // int32 on 32-bit platforms
	}
	return int64(st.Bsize) //nolint:unconvert // int32 on 32-bit platforms
}
