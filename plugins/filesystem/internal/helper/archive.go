package helper

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"strings"

	"console-filesystem-plugin/internal/rootfs"
)

// ErrArchiveTooLarge ends an archive that has grown past the configured cap.
// It is surfaced rather than silently truncating, because a truncated archive
// is indistinguishable from a complete one once it has been downloaded.
var ErrArchiveTooLarge = errors.New("archive exceeds the size limit")

// ArchiveOptions bounds one archive. There is no format or compression level
// here: this side only ever produces an uncompressed tar, and the agent
// decides what to wrap it in.
type ArchiveOptions struct {
	MaxBytes   int64
	MaxEntries int
}

// WriteTar walks path inside root and writes it to w as an uncompressed tar.
//
// Entry names are relative to path's *parent*, so unpacking the result
// recreates the directory itself rather than spilling its contents into the
// current directory -- the behaviour of `tar cf x.tar somedir`.
func WriteTar(w io.Writer, root *rootfs.Root, path string, opts ArchiveOptions) error {
	base, err := rootfs.CleanPath(path)
	if err != nil {
		return err
	}
	prefix := ""
	if i := strings.LastIndex(base, "/"); i >= 0 {
		prefix = base[:i+1]
	}
	if base == "." {
		// Archiving "/" has no parent to be relative to; the top entry is
		// named "root" instead.
		prefix = ""
	}

	counter := &countingWriter{w: w, limit: opts.MaxBytes}
	tw := tar.NewWriter(counter)

	err = walk(root, path, prefix, opts.MaxEntries, func(name string, entry *rootfs.Stat, link string, open func() (io.ReadCloser, error)) error {
		header := &tar.Header{
			Name:     name,
			Mode:     int64(entry.RawMode),
			Uid:      int(entry.UID),
			Gid:      int(entry.GID),
			ModTime:  entry.ModTime,
			Linkname: link,
		}
		switch {
		case entry.IsDir():
			header.Typeflag, header.Name = tar.TypeDir, name+"/"
		case entry.IsSymlink():
			header.Typeflag = tar.TypeSymlink
		default:
			header.Typeflag, header.Size = tar.TypeReg, entry.Size
		}
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		if header.Typeflag != tar.TypeReg {
			return nil
		}
		f, err := open()
		if err != nil {
			return err
		}
		defer f.Close()
		// Bounded by the header size that was just written: a file being
		// appended to while it is archived would otherwise desynchronise the
		// stream.
		_, err = io.CopyN(tw, f, entry.Size)
		if errors.Is(err, io.EOF) {
			// The file shrank instead; the entry is already padded to its
			// declared size by the tar writer.
			return nil
		}
		return err
	})
	if err != nil {
		return err
	}
	return tw.Close()
}

// countingWriter enforces the size cap. It counts the *uncompressed* tar,
// which is the pessimistic reading of a cap the operator set -- whatever the
// agent then compresses it to can only be smaller.
type countingWriter struct {
	w       io.Writer
	limit   int64
	written int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	if c.limit > 0 && c.written+int64(len(p)) > c.limit {
		return 0, ErrArchiveTooLarge
	}
	n, err := c.w.Write(p)
	c.written += int64(n)
	return n, err
}

// walk visits path and everything under it, depth first and in name order,
// handing the caller the archive-relative name plus a lazy opener.
//
// Anything that is not a directory, a regular file or a symlink -- devices,
// sockets, fifos -- is skipped: tar does not round-trip them into a browser
// download in any useful way.
func walk(root *rootfs.Root, path, prefix string, maxEntries int, visit func(name string, entry *rootfs.Stat, link string, open func() (io.ReadCloser, error)) error) error {
	count := 0
	var recurse func(current string) error
	recurse = func(current string) error {
		st, err := root.Lstat(current)
		if err != nil {
			return err
		}
		count++
		if maxEntries > 0 && count > maxEntries {
			return fmt.Errorf("%w: more than %d entries", ErrArchiveTooLarge, maxEntries)
		}

		name := archiveName(current, prefix)
		link := ""
		if st.IsSymlink() {
			link, _ = root.Readlink(current)
		}
		if st.IsDir() || st.IsRegular() || st.IsSymlink() {
			if err := visit(name, st, link, func() (io.ReadCloser, error) { return root.Open(current) }); err != nil {
				return err
			}
		}
		if !st.IsDir() {
			return nil
		}
		// A symlinked directory is archived as the link itself (handled
		// above), never descended into, so a self-referential link cannot
		// make this loop.
		entries, _, err := root.List(current, 0)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := recurse(rootfs.Join(current, entry.Stat.Name)); err != nil {
				return err
			}
		}
		return nil
	}
	return recurse(path)
}

func archiveName(current, prefix string) string {
	cleaned, err := rootfs.CleanPath(current)
	if err != nil {
		return current
	}
	if cleaned == "." {
		return "root"
	}
	return strings.TrimPrefix(cleaned, prefix)
}
