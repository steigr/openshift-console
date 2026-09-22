//go:build !linux

package rootfs

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// maxSymlinks matches Linux's own limit, so a symlink loop is reported the
// same way it would be in the cluster.
const maxSymlinks = 40

// Root emulates openat2(RESOLVE_IN_ROOT) in user space.
//
// This build exists so the agent's logic -- archiving, extraction, listing,
// upload chunking -- can be unit-tested on a developer's machine. It is not
// what runs in a cluster: resolution here is a sequence of separate lstat
// and readlink calls, so a process inside the container could swap a
// component between two of them. The agent command refuses to serve on any
// platform that lands on this file (see agent.Serve).
type Root struct {
	dir string
}

func Open(dir string) (*Root, error) {
	st, err := os.Stat(dir)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		return nil, &os.PathError{Op: "open", Path: dir, Err: os.ErrInvalid}
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	return &Root{dir: abs}, nil
}

func (r *Root) Close() error { return nil }

// resolve walks p one component at a time, applying the two rules openat2
// would: ".." never goes above the root, and a symlink's target -- absolute
// or not -- is interpreted inside the root.
func (r *Root) resolve(op, p string, followFinal bool) (string, error) {
	cleaned, err := CleanPath(p)
	if err != nil {
		return "", &os.PathError{Op: op, Path: p, Err: err}
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
				// resolution failure: it is exactly what creating a file or
				// a directory starts from, and openat2 with O_CREAT resolves
				// it the same way.
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
		if strings.HasPrefix(target, "/") {
			stack = nil
		}
		remaining = append(splitComponents(strings.TrimLeft(target, "/")), remaining...)
	}
	return filepath.Join(append([]string{r.dir}, stack...)...), nil
}

func (r *Root) Open(p string) (*os.File, error) {
	host, err := r.resolve("open", p, true)
	if err != nil {
		return nil, err
	}
	return os.Open(host)
}

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

func (r *Root) List(p string, limit int) ([]Dirent, bool, error) {
	host, err := r.resolve("open", p, true)
	if err != nil {
		return nil, false, err
	}
	names, err := readDirNames(host)
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
			continue
		}
		entry := Dirent{Stat: toStat(name, info)}
		if entry.Stat.IsSymlink() {
			entry.LinkTarget, _ = os.Readlink(filepath.Join(host, name))
			if target, err := r.Stat(Join(p, name)); err == nil {
				entry.TargetIsDir = target.IsDir()
			}
		}
		entries = append(entries, entry)
	}
	return entries, truncated, nil
}

func readDirNames(host string) ([]string, error) {
	dir, err := os.Open(host)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	return dir.Readdirnames(-1)
}

func (r *Root) Mkdir(p string, perm fs.FileMode) error {
	host, err := r.resolve("mkdir", p, false)
	if err != nil {
		return err
	}
	return os.Mkdir(host, perm)
}

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
	return os.Rename(fromHost, toHost)
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

// Statfs has no portable equivalent; the fields it fills in the Info dialog
// are simply absent off Linux.
func (r *Root) Statfs(p string) (*FSInfo, error) {
	if _, err := r.resolve("statfs", p, true); err != nil {
		return nil, err
	}
	return &FSInfo{Type: fmt.Sprintf("unknown (%s)", "no statfs on this platform")}, nil
}

// toStat fills only what fs.FileInfo exposes. Ownership, inode and the other
// two timestamps live in each platform's own stat struct under a different
// name, and this build serves tests rather than a cluster, so it does not
// reach for them.
func toStat(name string, info fs.FileInfo) *Stat {
	return &Stat{
		Name:      name,
		Size:      info.Size(),
		Mode:      info.Mode(),
		RawMode:   uint32(info.Mode().Perm()),
		ModTime:   info.ModTime(),
		HardLinks: 1,
	}
}
