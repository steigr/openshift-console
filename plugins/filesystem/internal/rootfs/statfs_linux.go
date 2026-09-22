//go:build linux

package rootfs

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func statfs(host string) (*FSInfo, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(host, &st); err != nil {
		return nil, &os.PathError{Op: "statfs", Path: host, Err: err}
	}
	return &FSInfo{
		Type:       fsTypeName(int64(st.Type)),
		TotalBytes: st.Blocks * uint64(st.Bsize),
		FreeBytes:  st.Bavail * uint64(st.Bsize),
	}, nil
}

// fsTypeName maps the handful of magic numbers a container's filesystem
// realistically reports; anything else is shown as its magic, which is still
// more useful to an operator than nothing.
func fsTypeName(magic int64) string {
	switch magic {
	case unix.OVERLAYFS_SUPER_MAGIC:
		return "overlayfs"
	case unix.EXT4_SUPER_MAGIC:
		return "ext2/ext3/ext4"
	case unix.XFS_SUPER_MAGIC:
		return "xfs"
	case unix.BTRFS_SUPER_MAGIC:
		return "btrfs"
	case unix.TMPFS_MAGIC:
		return "tmpfs"
	case unix.NFS_SUPER_MAGIC:
		return "nfs"
	case unix.CEPH_SUPER_MAGIC:
		return "ceph"
	case unix.FUSE_SUPER_MAGIC:
		return "fuse"
	case unix.SQUASHFS_MAGIC:
		return "squashfs"
	case unix.PROC_SUPER_MAGIC:
		return "proc"
	case unix.SYSFS_MAGIC:
		return "sysfs"
	case unix.CGROUP2_SUPER_MAGIC:
		return "cgroup2"
	case 0x2fc12fc1: // ZFS_SUPER_MAGIC, which x/sys/unix does not name
		return "zfs"
	default:
		return fmt.Sprintf("0x%x", uint64(magic))
	}
}
