// Package rootfs resolves paths inside another container's filesystem
// without ever letting one escape it.
//
// The agent reaches a container through /proc/<pid>/root, which the kernel
// resolves in that process's mount namespace. That alone is not safe: while
// the first component is resolved in the container's namespace, an absolute
// symlink met along the way is resolved against the agent's own root, so a
// container that plants /data -> /etc hands the browser the node's /etc. Nor
// can the naive fix (refuse absolute symlinks) be used, as container images
// are full of them -- /usr/bin -> /bin, /etc/localtime ->
// /usr/share/zoneinfo/..., every /lib64 on a merged-usr distro.
//
// What is needed is openat2(2)'s RESOLVE_IN_ROOT: absolute symlinks and ".."
// are both reinterpreted against a root directory of our choosing, in the
// kernel, atomically -- so a container process cannot win a race by swapping
// a component for a symlink between our check and our open. Root wraps that
// on Linux (rootfs_linux.go). Elsewhere -- which means a developer's machine
// running the unit tests, never a cluster -- rootfs_portable.go emulates the
// same rules in user space; it is race-prone by construction, and the agent
// command refuses to start on such a platform.
//
// os.Root (Go 1.24+) is the obvious-looking alternative and is the wrong
// tool here: it rejects every absolute symlink as an escape, including the
// ones that resolve back inside the root.
package rootfs

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"
	"time"
)

// ErrEscape is returned for a path that leaves the root.
var ErrEscape = errors.New("path escapes the container filesystem")

// ErrUnsupported is returned when the kernel has no openat2(2) (pre-5.6), or
// when this package was built for a platform that has none at all.
var ErrUnsupported = errors.New("resolving paths inside a container requires openat2(2) (Linux 5.6+)")

// ErrCrossDevice is returned by Rename when source and destination sit on
// different filesystems inside the container, which rename(2) cannot do. It
// is distinct from ErrEscape on purpose: both surface as EXDEV, but only one
// of them means the caller tried to leave the container.
var ErrCrossDevice = errors.New("cannot move across filesystems inside the container")

// Stat is everything the browser shows about one entry. It replaces
// fs.FileInfo deliberately: the "Info" dialog wants the fields that only
// live in the platform's raw stat struct (link count, device, inode, the
// other two timestamps), and those have different names on each platform, so
// reading them through FileInfo.Sys() would not compile everywhere this
// package is built.
type Stat struct {
	Name string
	Size int64
	// Mode is the portable form, for IsDir/IsRegular style checks.
	Mode fs.FileMode
	// RawMode is st_mode's permission and setuid/setgid/sticky bits, i.e.
	// what `ls -l` renders and `chmod` takes.
	RawMode    uint32
	UID, GID   uint32
	ModTime    time.Time
	AccessTime time.Time
	ChangeTime time.Time
	HardLinks  uint64
	Device     uint64
	Inode      uint64
}

func (s *Stat) IsDir() bool     { return s.Mode.IsDir() }
func (s *Stat) IsRegular() bool { return s.Mode.IsRegular() }
func (s *Stat) IsSymlink() bool { return s.Mode&fs.ModeSymlink != 0 }

// Dirent is one member of a directory, with the lstat already done: a
// listing resolves every entry from the directory's own handle, so the
// caller never has to re-walk the path per entry.
type Dirent struct {
	Stat *Stat
	// LinkTarget is the unresolved contents of a symlink, empty otherwise.
	LinkTarget string
	// TargetIsDir reports whether a symlink resolves, inside this root, to a
	// directory -- which is what decides if the tree lets it be expanded.
	TargetIsDir bool
}

// FSInfo describes the filesystem an entry lives on.
type FSInfo struct {
	Type       string
	TotalBytes uint64
	FreeBytes  uint64
}

// CleanPath normalizes an absolute in-container path to the slash-separated,
// leading-slash-free form both implementations resolve against the root
// handle. "" and "/" both become ".".
//
// This is a convenience, not the security boundary: ".." components are left
// in place deliberately, because clamping them here would mean resolving
// symlinks in user space, which is exactly what this package exists to
// avoid. The kernel applies them against the root instead.
func CleanPath(p string) (string, error) {
	if strings.ContainsRune(p, 0) {
		return "", fmt.Errorf("%w: path contains a NUL byte", os.ErrInvalid)
	}
	p = strings.TrimLeft(p, "/")
	if p == "" {
		return ".", nil
	}
	return p, nil
}

// SplitParent splits an in-container path into the directory to resolve and
// the final component to act on. Operations that must not follow a symlink
// in their last position (lstat, rename, unlink, mkdir) resolve the parent
// and then use an *at syscall against it.
func SplitParent(p string) (dir, base string, err error) {
	cleaned, err := CleanPath(p)
	if err != nil {
		return "", "", err
	}
	if cleaned == "." {
		return "", "", fmt.Errorf("%w: the filesystem root has no parent", os.ErrInvalid)
	}
	i := strings.LastIndex(cleaned, "/")
	if i < 0 {
		return ".", cleaned, nil
	}
	dir, base = cleaned[:i], cleaned[i+1:]
	if dir == "" {
		dir = "."
	}
	if base == "" || base == "." || base == ".." {
		return "", "", fmt.Errorf("%w: %q has no final component", os.ErrInvalid, p)
	}
	return dir, base, nil
}

// Join builds an in-container path from a directory and a child name,
// keeping the leading slash the frontend and the API both use.
func Join(dir, name string) string {
	dir = "/" + strings.Trim(dir, "/")
	if dir == "/" {
		return "/" + name
	}
	return dir + "/" + name
}
