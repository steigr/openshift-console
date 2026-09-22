package rootfs

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// maxSymlinks matches Linux's own limit, so a symlink loop in the sandbox is
// reported the way it would be in the cluster.
const maxSymlinks = 40

// Root is a filesystem root: either this process's own (Native, after the
// helper has joined the container's mount namespace) or a directory standing
// in for one (Sandbox, for tests).
type Root struct {
	dir string
	// native short-circuits every path resolution. See the package comment:
	// when "/" is already the container's root there is nothing to emulate,
	// and emulating it would be strictly worse -- a user-space walk is
	// neither atomic nor able to see everything the kernel sees.
	native bool
}

// Native is the root of the process calling it, which in the helper is the
// container's own root.
func Native() *Root { return &Root{dir: "/", native: true} }

// Sandbox treats an ordinary directory as if it were a filesystem root,
// clamping ".." at it and reinterpreting absolute symlinks against it. It is
// how the tests exercise this package without joining a namespace; the
// resolution is a sequence of separate lstat and readlink calls, so it is
// race-prone and must not be used against a filesystem someone else can
// change underneath it.
func Sandbox(dir string) (*Root, error) {
	info, err := os.Stat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, &os.PathError{Op: "open", Path: dir, Err: os.ErrInvalid}
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	return &Root{dir: abs}, nil
}

func (r *Root) Close() error { return nil }

// resolve turns an in-container path into one this process can pass to os.
func (r *Root) resolve(op, p string, followFinal bool) (string, error) {
	cleaned, err := CleanPath(p)
	if err != nil {
		return "", &os.PathError{Op: op, Path: p, Err: err}
	}
	if r.native {
		if cleaned == "." {
			return "/", nil
		}
		return "/" + cleaned, nil
	}

	var stack []string
	remaining := splitComponents(cleaned)
	hops := 0

	for len(remaining) > 0 {
		part := remaining[0]
		remaining = remaining[1:]
		if part == ".." {
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
			continue
		}
		next := append(append([]string{}, stack...), part)
		host := filepath.Join(append([]string{r.dir}, next...)...)
		info, err := os.Lstat(host)
		if err != nil {
			if len(remaining) == 0 && errors.Is(err, fs.ErrNotExist) {
				// A missing final component is the caller's business, not a
				// resolution failure: it is what creating a file starts from.
				stack = next
				break
			}
			return "", &os.PathError{Op: op, Path: p, Err: err}
		}
		isLast := len(remaining) == 0
		if info.Mode()&fs.ModeSymlink == 0 || (isLast && !followFinal) {
			stack = next
			continue
		}
		hops++
		if hops > maxSymlinks {
			return "", &os.PathError{Op: op, Path: p, Err: errors.New("too many levels of symbolic links")}
		}
		target, err := os.Readlink(host)
		if err != nil {
			return "", &os.PathError{Op: op, Path: p, Err: err}
		}
		if filepath.IsAbs(target) {
			stack = nil
		}
		remaining = append(splitComponents(trimLeadingSlashes(target)), remaining...)
	}
	return filepath.Join(append([]string{r.dir}, stack...)...), nil
}

func trimLeadingSlashes(p string) string {
	for len(p) > 0 && p[0] == '/' {
		p = p[1:]
	}
	return p
}

func (r *Root) Open(p string) (*os.File, error) {
	host, err := r.resolve("open", p, true)
	if err != nil {
		return nil, err
	}
	return os.Open(host)
}

// OpenWrite opens a file for writing, creating it if needed. truncate is set
// for the first chunk of an upload, so a re-sent upload replaces the file
// rather than leaving a longer old one's tail behind.
func (r *Root) OpenWrite(p string, perm fs.FileMode, truncate bool) (*os.File, error) {
	host, err := r.resolve("open", p, true)
	if err != nil {
		return nil, err
	}
	flags := os.O_WRONLY | os.O_CREATE
	if truncate {
		flags |= os.O_TRUNC
	}
	return os.OpenFile(host, flags, perm)
}

func (r *Root) Stat(p string) (*Stat, error) {
	host, err := r.resolve("stat", p, true)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(host)
	if err != nil {
		return nil, err
	}
	return toStat(baseName(p), info), nil
}

func (r *Root) Lstat(p string) (*Stat, error) {
	if cleaned, err := CleanPath(p); err == nil && cleaned == "." {
		return r.Stat(p)
	}
	host, err := r.resolve("lstat", p, false)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(host)
	if err != nil {
		return nil, err
	}
	return toStat(baseName(p), info), nil
}

func (r *Root) Readlink(p string) (string, error) {
	host, err := r.resolve("readlink", p, false)
	if err != nil {
		return "", err
	}
	return os.Readlink(host)
}

// List reads one directory, lstat'ing every member. limit caps how many
// entries come back and the second result reports whether more were there: a
// container's /proc or a maildir can hold far more than a tree view can
// usefully show, and the alternative to a cap is an unbounded response.
func (r *Root) List(p string, limit int) ([]Dirent, bool, error) {
	host, err := r.resolve("open", p, true)
	if err != nil {
		return nil, false, err
	}
	dir, err := os.Open(host)
	if err != nil {
		return nil, false, err
	}
	names, err := dir.Readdirnames(-1)
	_ = dir.Close()
	if err != nil {
		return nil, false, err
	}
	sort.Strings(names)

	truncated := false
	if limit > 0 && len(names) > limit {
		names, truncated = names[:limit], true
	}

	entries := make([]Dirent, 0, len(names))
	for _, name := range names {
		info, err := os.Lstat(filepath.Join(host, name))
		if err != nil {
			// An entry that vanished between readdir and stat, or one we may
			// not stat, is skipped rather than failing the whole listing:
			// /proc in particular churns constantly.
			continue
		}
		entry := Dirent{Stat: toStat(name, info)}
		if entry.Stat.IsSymlink() {
			entry.LinkTarget, _ = os.Readlink(filepath.Join(host, name))
			// Resolved from the root rather than from the directory, because
			// an absolute target means "absolute inside this container".
			if target, err := r.Stat(Join(p, name)); err == nil {
				entry.TargetIsDir = target.IsDir()
			}
		}
		entries = append(entries, entry)
	}
	return entries, truncated, nil
}

func (r *Root) Mkdir(p string, perm fs.FileMode) error {
	host, err := r.resolve("mkdir", p, false)
	if err != nil {
		return err
	}
	return os.Mkdir(host, perm)
}

// MkdirAll creates p and any missing parent. Each component is resolved in
// its own right, so a symlinked parent is followed as far as it stays inside
// the root.
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
	host, err := r.resolve("remove", p, false)
	if err != nil {
		return err
	}
	return os.Remove(host)
}

// Rename moves within the root. overwrite=false refuses to replace an
// existing name, so a drag-and-drop cannot silently clobber a file.
func (r *Root) Rename(from, to string, overwrite bool) error {
	fromHost, err := r.resolve("rename", from, false)
	if err != nil {
		return err
	}
	toHost, err := r.resolve("rename", to, false)
	if err != nil {
		return err
	}
	if !overwrite {
		if _, err := os.Lstat(toHost); err == nil {
			return &os.LinkError{Op: "rename", Old: from, New: to, Err: os.ErrExist}
		}
	}
	if err := os.Rename(fromHost, toHost); err != nil {
		return renameErr(from, to, err)
	}
	return nil
}

func (r *Root) Chmod(p string, perm fs.FileMode) error {
	host, err := r.resolve("chmod", p, true)
	if err != nil {
		return err
	}
	return os.Chmod(host, perm)
}

func (r *Root) Chown(p string, uid, gid uint32) error {
	host, err := r.resolve("chown", p, false)
	if err != nil {
		return err
	}
	return os.Lchown(host, int(uid), int(gid))
}

func (r *Root) Chtimes(p string, atime, mtime time.Time) error {
	host, err := r.resolve("chtimes", p, false)
	if err != nil {
		return err
	}
	return os.Chtimes(host, atime, mtime)
}

func (r *Root) Symlink(target, p string) error {
	host, err := r.resolve("symlink", p, false)
	if err != nil {
		return err
	}
	return os.Symlink(target, host)
}

// Statfs reports the filesystem an entry sits on, which is what tells a user
// whether the upload they are about to start has anywhere to land.
func (r *Root) Statfs(p string) (*FSInfo, error) {
	host, err := r.resolve("statfs", p, true)
	if err != nil {
		return nil, err
	}
	return statfs(host)
}
