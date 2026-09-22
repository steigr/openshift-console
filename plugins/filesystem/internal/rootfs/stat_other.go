//go:build !linux

package rootfs

import (
	"io/fs"
)

// toStat fills only what fs.FileInfo exposes. Ownership, inode and the other
// two timestamps live in each platform's own stat struct under a different
// name, and this build serves tests rather than a cluster, so it does not
// reach for them.
func toStat(name string, info fs.FileInfo) *Stat {
	return &Stat{
		Name:      name,
		Size:      info.Size(),
		Mode:      info.Mode(),
		RawMode:   uint32(info.Mode().Perm()) | rawSpecialBits(info.Mode()),
		ModTime:   info.ModTime(),
		HardLinks: 1,
	}
}

func renameErr(_, _ string, err error) error { return err }
