//go:build linux

package rootfs

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"time"

	"golang.org/x/sys/unix"
)

// resolveFlags is applied to every openat2 this package makes.
//
// RESOLVE_IN_ROOT is the whole point (see the package comment).
// RESOLVE_NO_MAGICLINKS is added because a container's own /proc is a way
// back out through /proc/<pid>/root and /proc/<pid>/fd/<n> -- doubly so on a
// pod with hostPID, where that procfs is the node's. A file browser has no
// business following those.
const resolveFlags = unix.RESOLVE_IN_ROOT | unix.RESOLVE_NO_MAGICLINKS

// Root is a handle on one container's filesystem root.
type Root struct {
	fd   int
	name string
}

// Open takes a handle on dir -- in the agent, /proc/<pid>/root of a process
// inside the target container. The O_PATH handle is enough to resolve
// against and costs nothing to hold, and it pins the directory: if the
// container exits and the PID is recycled, every later openat2 fails rather
// than silently landing in a different container.
func Open(dir string) (*Root, error) {
	fd, err := unix.Open(dir, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: dir, Err: err}
	}
	r := &Root{fd: fd, name: dir}

	// Probe openat2 once, so an old kernel is reported as such at the point
	// the container is opened rather than as a confusing failure on whatever
	// the user happened to click first.
	probe, err := unix.Openat2(fd, ".", &unix.OpenHow{
		Flags:   unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC,
		Resolve: resolveFlags,
	})
	if err != nil {
		_ = r.Close()
		if errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EINVAL) || errors.Is(err, unix.EPERM) {
			return nil, ErrUnsupported
		}
		return nil, &os.PathError{Op: "openat2", Path: dir, Err: err}
	}
	_ = unix.Close(probe)
	return r, nil
}

func (r *Root) Close() error {
	if r.fd < 0 {
		return nil
	}
	err := unix.Close(r.fd)
	r.fd = -1
	return err
}

// openat2 resolves p inside the root. EXDEV is openat2's way of saying the
// resolution would have left the root, which it is worth translating: it is
// otherwise reported to the user as "invalid cross-device link" on an
// operation that never involved two devices.
func (r *Root) openat2(op, p string, flags, mode uint64) (int, error) {
	cleaned, err := CleanPath(p)
	if err != nil {
		return -1, &os.PathError{Op: op, Path: p, Err: err}
	}
	fd, err := unix.Openat2(r.fd, cleaned, &unix.OpenHow{
		Flags:   flags | unix.O_CLOEXEC,
		Mode:    mode,
		Resolve: resolveFlags,
	})
	if err != nil {
		return -1, &os.PathError{Op: op, Path: p, Err: translate(err)}
	}
	return fd, nil
}

func translate(err error) error {
	switch {
	case errors.Is(err, unix.EXDEV):
		return ErrEscape
	case errors.Is(err, unix.ENOSYS):
		return ErrUnsupported
	default:
		return err
	}
}

// parent resolves the directory holding p and returns its fd plus the final
// component, for the operations that must act on the name itself rather than
// on whatever it points at.
func (r *Root) parent(op, p string) (int, string, error) {
	dir, base, err := SplitParent(p)
	if err != nil {
		return -1, "", &os.PathError{Op: op, Path: p, Err: err}
	}
	fd, err := r.openat2(op, dir, unix.O_PATH|unix.O_DIRECTORY, 0)
	if err != nil {
		return -1, "", err
	}
	return fd, base, nil
}

// Open opens a file for reading, following symlinks inside the root.
func (r *Root) Open(p string) (*os.File, error) {
	fd, err := r.openat2("open", p, unix.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), p), nil
}

// OpenWrite opens a file for writing, creating it if needed. truncate is set
// for the first chunk of an upload, so a re-sent upload replaces the file
// rather than leaving a longer old one's tail behind.
func (r *Root) OpenWrite(p string, perm fs.FileMode, truncate bool) (*os.File, error) {
	flags := uint64(unix.O_WRONLY | unix.O_CREAT)
	if truncate {
		flags |= unix.O_TRUNC
	}
	fd, err := r.openat2("open", p, flags, uint64(perm.Perm()))
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), p), nil
}

// Stat follows symlinks; Lstat does not.
func (r *Root) Stat(p string) (*Stat, error) {
	fd, err := r.openat2("stat", p, unix.O_PATH, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return nil, &os.PathError{Op: "stat", Path: p, Err: err}
	}
	return toStat(baseName(p), &st), nil
}

func (r *Root) Lstat(p string) (*Stat, error) {
	if cleaned, err := CleanPath(p); err == nil && cleaned == "." {
		return r.Stat(p)
	}
	dirFd, base, err := r.parent("lstat", p)
	if err != nil {
		return nil, err
	}
	defer unix.Close(dirFd)
	var st unix.Stat_t
	if err := unix.Fstatat(dirFd, base, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return nil, &os.PathError{Op: "lstat", Path: p, Err: err}
	}
	return toStat(base, &st), nil
}

func (r *Root) Readlink(p string) (string, error) {
	dirFd, base, err := r.parent("readlink", p)
	if err != nil {
		return "", err
	}
	defer unix.Close(dirFd)
	return readlinkat(dirFd, base, p)
}

func readlinkat(dirFd int, name, reported string) (string, error) {
	for size := 256; size <= 64*1024; size *= 2 {
		buf := make([]byte, size)
		n, err := unix.Readlinkat(dirFd, name, buf)
		if err != nil {
			return "", &os.PathError{Op: "readlink", Path: reported, Err: err}
		}
		if n < size {
			return string(buf[:n]), nil
		}
	}
	return "", &os.PathError{Op: "readlink", Path: reported, Err: unix.ENAMETOOLONG}
}

// List reads one directory. Every entry is stat'ed from the directory's own
// handle, so the listing costs one path resolution rather than one per
// entry; only symlinks need a second resolution, to find out whether they
// point at a directory (which is what lets the tree offer to expand them).
//
// limit caps how many entries are returned; the second result reports
// whether more were there. A container's /proc or a maildir can hold far
// more than a tree view can usefully show, and the alternative to a cap is
// an unbounded response.
func (r *Root) List(p string, limit int) ([]Dirent, bool, error) {
	fd, err := r.openat2("open", p, unix.O_RDONLY|unix.O_DIRECTORY, 0)
	if err != nil {
		return nil, false, err
	}
	dir := os.NewFile(uintptr(fd), p)
	defer dir.Close()

	names, err := dir.Readdirnames(-1)
	if err != nil {
		return nil, false, &os.PathError{Op: "readdir", Path: p, Err: err}
	}
	sort.Strings(names)

	truncated := false
	if limit > 0 && len(names) > limit {
		names, truncated = names[:limit], true
	}

	// Fd() is taken after Readdirnames so the directory stream is already
	// drained; it stays valid for the fstatat calls below.
	dirFd := int(dir.Fd())

	entries := make([]Dirent, 0, len(names))
	for _, name := range names {
		var st unix.Stat_t
		if err := unix.Fstatat(dirFd, name, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			// An entry that vanished between readdir and stat, or one whose
			// name we may not stat, is skipped rather than failing the whole
			// listing: /proc in particular churns constantly.
			continue
		}
		entry := Dirent{Stat: toStat(name, &st)}
		if entry.Stat.IsSymlink() {
			if target, err := readlinkat(dirFd, name, Join(p, name)); err == nil {
				entry.LinkTarget = target
			}
			// Resolved from the root rather than from dirFd, because an
			// absolute target means "absolute inside this container".
			if target, err := r.Stat(Join(p, name)); err == nil {
				entry.TargetIsDir = target.IsDir()
			}
		}
		entries = append(entries, entry)
	}
	return entries, truncated, nil
}

func (r *Root) Mkdir(p string, perm fs.FileMode) error {
	dirFd, base, err := r.parent("mkdir", p)
	if err != nil {
		return err
	}
	defer unix.Close(dirFd)
	if err := unix.Mkdirat(dirFd, base, uint32(perm.Perm())); err != nil {
		return &os.PathError{Op: "mkdir", Path: p, Err: err}
	}
	return nil
}

// MkdirAll creates p and any missing parent, like os.MkdirAll. Each
// component is resolved from the root in its own right, so a symlinked
// parent is followed exactly as far as it stays inside the container.
func (r *Root) MkdirAll(p string, perm fs.FileMode) error {
	cleaned, err := CleanPath(p)
	if err != nil {
		return &os.PathError{Op: "mkdir", Path: p, Err: err}
	}
	if cleaned == "." {
		return nil
	}
	var built string
	for _, part := range splitComponents(cleaned) {
		if built == "" {
			built = part
		} else {
			built += "/" + part
		}
		if err := r.Mkdir("/"+built, perm); err != nil {
			if st, statErr := r.Stat("/" + built); statErr == nil && st.IsDir() {
				continue
			}
			return err
		}
	}
	return nil
}

func (r *Root) Remove(p string) error {
	dirFd, base, err := r.parent("remove", p)
	if err != nil {
		return err
	}
	defer unix.Close(dirFd)

	if err := unix.Unlinkat(dirFd, base, 0); err == nil {
		return nil
	} else if !errors.Is(err, unix.EISDIR) && !errors.Is(err, unix.EPERM) {
		return &os.PathError{Op: "remove", Path: p, Err: err}
	}
	if err := unix.Unlinkat(dirFd, base, unix.AT_REMOVEDIR); err != nil {
		return &os.PathError{Op: "remove", Path: p, Err: err}
	}
	return nil
}

// Rename moves within the container. overwrite=false uses RENAME_NOREPLACE
// where the filesystem supports it, so a drag-and-drop cannot silently
// clobber a file; where it does not (overlayfs on older kernels answers
// EINVAL), it falls back to a lstat check, which is racy but no worse than
// what the shell does.
func (r *Root) Rename(from, to string, overwrite bool) error {
	fromDir, fromBase, err := r.parent("rename", from)
	if err != nil {
		return err
	}
	defer unix.Close(fromDir)
	toDir, toBase, err := r.parent("rename", to)
	if err != nil {
		return err
	}
	defer unix.Close(toDir)

	if !overwrite {
		err := unix.Renameat2(fromDir, fromBase, toDir, toBase, unix.RENAME_NOREPLACE)
		switch {
		case err == nil:
			return nil
		case errors.Is(err, unix.EEXIST):
			return &os.LinkError{Op: "rename", Old: from, New: to, Err: unix.EEXIST}
		case errors.Is(err, unix.ENOSYS), errors.Is(err, unix.EINVAL), errors.Is(err, unix.EOPNOTSUPP):
			var st unix.Stat_t
			if statErr := unix.Fstatat(toDir, toBase, &st, unix.AT_SYMLINK_NOFOLLOW); statErr == nil {
				return &os.LinkError{Op: "rename", Old: from, New: to, Err: unix.EEXIST}
			}
		default:
			return &os.LinkError{Op: "rename", Old: from, New: to, Err: renameErr(err)}
		}
	}
	if err := unix.Renameat(fromDir, fromBase, toDir, toBase); err != nil {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: renameErr(err)}
	}
	return nil
}

// renameErr keeps EXDEV meaning what it means for rename(2) -- two different
// filesystems -- instead of the "escaped the container" reading openat2's
// EXDEV gets.
func renameErr(err error) error {
	if errors.Is(err, unix.EXDEV) {
		return ErrCrossDevice
	}
	return err
}

func (r *Root) Chmod(p string, perm fs.FileMode) error {
	dirFd, base, err := r.parent("chmod", p)
	if err != nil {
		return err
	}
	defer unix.Close(dirFd)
	// Linux's fchmodat has no AT_SYMLINK_NOFOLLOW (it answers ENOTSUP), and
	// chmod through a symlink is what every tool does anyway.
	if err := unix.Fchmodat(dirFd, base, uint32(perm.Perm()), 0); err != nil {
		return &os.PathError{Op: "chmod", Path: p, Err: err}
	}
	return nil
}

func (r *Root) Chown(p string, uid, gid uint32) error {
	dirFd, base, err := r.parent("chown", p)
	if err != nil {
		return err
	}
	defer unix.Close(dirFd)
	if err := unix.Fchownat(dirFd, base, int(uid), int(gid), unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return &os.PathError{Op: "chown", Path: p, Err: err}
	}
	return nil
}

func (r *Root) Chtimes(p string, atime, mtime time.Time) error {
	dirFd, base, err := r.parent("chtimes", p)
	if err != nil {
		return err
	}
	defer unix.Close(dirFd)
	ts := []unix.Timespec{
		unix.NsecToTimespec(atime.UnixNano()),
		unix.NsecToTimespec(mtime.UnixNano()),
	}
	if err := unix.UtimesNanoAt(dirFd, base, ts, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return &os.PathError{Op: "chtimes", Path: p, Err: err}
	}
	return nil
}

func (r *Root) Symlink(target, p string) error {
	dirFd, base, err := r.parent("symlink", p)
	if err != nil {
		return err
	}
	defer unix.Close(dirFd)
	if err := unix.Symlinkat(target, dirFd, base); err != nil {
		return &os.PathError{Op: "symlink", Path: p, Err: err}
	}
	return nil
}

// Statfs reports the filesystem an entry sits on, which is what tells a user
// whether the upload they are about to start has anywhere to land.
func (r *Root) Statfs(p string) (*FSInfo, error) {
	fd, err := r.openat2("statfs", p, unix.O_PATH, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)
	var st unix.Statfs_t
	if err := unix.Fstatfs(fd, &st); err != nil {
		return nil, &os.PathError{Op: "statfs", Path: p, Err: err}
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

func toStat(name string, st *unix.Stat_t) *Stat {
	return &Stat{
		Name:       name,
		Size:       st.Size,
		Mode:       modeFromRaw(st.Mode),
		RawMode:    st.Mode & 0o7777,
		UID:        st.Uid,
		GID:        st.Gid,
		ModTime:    time.Unix(st.Mtim.Sec, st.Mtim.Nsec),
		AccessTime: time.Unix(st.Atim.Sec, st.Atim.Nsec),
		ChangeTime: time.Unix(st.Ctim.Sec, st.Ctim.Nsec),
		HardLinks:  uint64(st.Nlink),
		Device:     uint64(st.Dev),
		Inode:      st.Ino,
	}
}

func modeFromRaw(raw uint32) fs.FileMode {
	mode := fs.FileMode(raw & 0o777)
	switch raw & unix.S_IFMT {
	case unix.S_IFDIR:
		mode |= fs.ModeDir
	case unix.S_IFLNK:
		mode |= fs.ModeSymlink
	case unix.S_IFIFO:
		mode |= fs.ModeNamedPipe
	case unix.S_IFSOCK:
		mode |= fs.ModeSocket
	case unix.S_IFBLK:
		mode |= fs.ModeDevice
	case unix.S_IFCHR:
		mode |= fs.ModeDevice | fs.ModeCharDevice
	}
	if raw&unix.S_ISUID != 0 {
		mode |= fs.ModeSetuid
	}
	if raw&unix.S_ISGID != 0 {
		mode |= fs.ModeSetgid
	}
	if raw&unix.S_ISVTX != 0 {
		mode |= fs.ModeSticky
	}
	return mode
}
