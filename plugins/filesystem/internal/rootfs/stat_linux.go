//go:build linux

package rootfs

import (
	"io/fs"
	"os"
	"syscall"
	"time"
)

// toStat reads the fields the Info dialog shows out of the platform's raw
// stat struct -- ownership, inode, link count and the two timestamps
// fs.FileInfo does not expose.
func toStat(name string, info fs.FileInfo) *Stat {
	stat := &Stat{
		Name:      name,
		Size:      info.Size(),
		Mode:      info.Mode(),
		RawMode:   uint32(info.Mode().Perm()) | rawSpecialBits(info.Mode()),
		ModTime:   info.ModTime(),
		HardLinks: 1,
	}
	raw, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return stat
	}
	stat.UID, stat.GID = raw.Uid, raw.Gid
	stat.HardLinks = uint64(raw.Nlink)
	stat.Device = uint64(raw.Dev)
	stat.Inode = raw.Ino
	stat.AccessTime = time.Unix(raw.Atim.Sec, raw.Atim.Nsec)
	stat.ChangeTime = time.Unix(raw.Ctim.Sec, raw.Ctim.Nsec)
	return stat
}

func renameErr(from, to string, err error) error {
	// EXDEV on rename means two filesystems, not "escaped the root"; saying so
	// is the difference between a user retrying with a copy and a user filing
	// a bug.
	if linkErr, ok := err.(*os.LinkError); ok && linkErr.Err == syscall.EXDEV {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: ErrCrossDevice}
	}
	return err
}
