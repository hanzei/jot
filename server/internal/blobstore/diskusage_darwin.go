package blobstore

import "syscall"

// statfsUnit is the size of the blocks statfs counts in: on darwin, f_bsize.
func statfsUnit(st *syscall.Statfs_t) int64 {
	return int64(st.Bsize)
}
