// Package rootfs is a filesystem root the rest of the plugin operates
// against.
//
// In production there is only one interesting root: "/" of the helper
// process, which has already joined the target container's mount namespace
// (internal/helper). Once that has happened the kernel *is* the boundary --
// the process's root directory is the container's, so an absolute path is
// scoped to it, absolute symlinks resolve inside it, and ".." above "/"
// clamps -- and this package gets out of the way, passing paths to the
// ordinary os calls.
//
// The second mode exists for tests, which cannot join a namespace: Sandbox
// takes an ordinary directory and emulates those same rules in user space, so
// the archive, extraction and listing logic can be exercised off-cluster. It
// is race-prone by construction and is never what runs in a cluster.
//
// An earlier design did all of this from outside the container, against
// /proc/<pid>/root, and had to use openat2(2)'s RESOLVE_IN_ROOT to be safe:
// resolved from the agent's own root, an absolute symlink inside the
// container (/data -> /etc, say) would otherwise have reached the node's
// /etc. That worked, but it needed Linux 5.6+, and every operation that must
// not follow a symlink in its last position had to be written twice -- once
// as an openat2 of the parent, once as the matching *at syscall. Entering the
// namespace removes the problem rather than defending against it.
package rootfs

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"
	"time"
)

// ErrEscape is returned by the sandbox for a path that leaves its root. The
// native root cannot produce it: there is nothing above "/" to escape to.
var ErrEscape = errors.New("path escapes the container filesystem")

// ErrCrossDevice is returned by Rename when source and destination sit on
// different filesystems inside the container, which rename(2) cannot do.
var ErrCrossDevice = errors.New("cannot move across filesystems inside the container")

// Stat is everything the browser shows about one entry. It replaces
// fs.FileInfo deliberately: the "Info" dialog wants the fields that only live
// in the platform's raw stat struct (link count, device, inode, the other two
// timestamps), and those have different names on each platform, so reading
// them through FileInfo.Sys() would not compile everywhere this package is
// built.
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

// Dirent is one member of a directory, with the lstat already done.
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

// CleanPath normalizes an in-container path to a slash-separated,
// leading-slash-free form. "" and "/" both become ".".
//
// ".." is deliberately left in place rather than collapsed: doing that
// lexically is wrong across a symlink, and both roots have something better
// to hand it to -- the kernel for the native root, a component-wise walk for
// the sandbox.
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

// SplitParent splits an in-container path into a directory and the final
// component to act on.
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

// Join builds an in-container path from a directory and a child name, keeping
// the leading slash the frontend and the API both use.
func Join(dir, name string) string {
	dir = "/" + strings.Trim(dir, "/")
	if dir == "/" {
		return "/" + name
	}
	return dir + "/" + name
}

// splitComponents drops empty and "." components, keeping "..".
func splitComponents(cleaned string) []string {
	parts := strings.Split(cleaned, "/")
	out := parts[:0]
	for _, part := range parts {
		if part == "" || part == "." {
			continue
		}
		out = append(out, part)
	}
	return out
}

// baseName is the final component of an in-container path, or "/" for the
// root itself -- used only to label a Stat.
func baseName(p string) string {
	cleaned, err := CleanPath(p)
	if err != nil || cleaned == "." {
		return "/"
	}
	parts := splitComponents(cleaned)
	if len(parts) == 0 {
		return "/"
	}
	return parts[len(parts)-1]
}
