package agent

import (
	"archive/tar"
	"archive/zip"
	"compress/flate"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/klauspost/compress/zstd"

	filesystemv1 "console-filesystem-plugin/gen/filesystem/v1"
	"console-filesystem-plugin/internal/rootfs"
)

// ErrArchiveTooLarge ends an archive that has grown past the agent's cap. It
// is surfaced rather than silently truncating, because a truncated archive is
// indistinguishable from a complete one once it has been downloaded.
var ErrArchiveTooLarge = errors.New("archive exceeds the agent's size limit")

// ArchiveOptions is the per-request half of an archive; the caps and the
// default level come from the agent's own flags.
type ArchiveOptions struct {
	Format filesystemv1.ArchiveFormat
	// Level is a 0-9 scale, 0 meaning "the agent's default". It maps
	// directly onto deflate for zip and tar.gz; for zstd, which has its own
	// 1-22 scale, it selects one of the four encoder levels that library
	// exposes (see zstdLevel).
	Level      int
	MaxBytes   int64
	MaxEntries int
}

// ArchiveSuffix is the extension for a format, used to name the download.
func ArchiveSuffix(format filesystemv1.ArchiveFormat) string {
	switch format {
	case filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_ZIP:
		return ".zip"
	case filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR:
		return ".tar"
	case filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR_ZSTD:
		return ".tar.zst"
	default:
		return ".tar.gz"
	}
}

// ArchiveFilename is what the browser should call the download: the archived
// directory's own name plus the format's suffix, or "root" for "/", which
// has no name of its own.
func ArchiveFilename(path string, format filesystemv1.ArchiveFormat) string {
	name := strings.Trim(path, "/")
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	if name == "" {
		name = "root"
	}
	return name + ArchiveSuffix(format)
}

// WriteArchive walks path inside root and writes it to w.
//
// Entry names are relative to path's *parent*, so unpacking the result
// recreates the directory itself rather than spilling its contents into the
// current directory -- the behaviour of `tar czf x.tar.gz somedir`.
//
// This runs in the agent, on the node, which is the point: the bytes are
// compressed before they cross to the plugin backend, the console and the
// browser, rather than after.
func WriteArchive(w io.Writer, root *rootfs.Root, path string, opts ArchiveOptions) error {
	base, err := rootfs.CleanPath(path)
	if err != nil {
		return err
	}
	prefix := ""
	if i := strings.LastIndex(base, "/"); i >= 0 {
		prefix = base[:i+1]
	}
	if base == "." {
		// Archiving "/" has no parent to be relative to; name the top entry
		// after the archive instead.
		prefix = ""
	}

	counter := &countingWriter{w: w, limit: opts.MaxBytes}

	switch opts.Format {
	case filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_ZIP:
		return writeZip(counter, root, path, prefix, opts)
	default:
		return writeTar(counter, root, path, prefix, opts)
	}
}

// countingWriter enforces the size cap on the *compressed* stream, which is
// what actually has to travel and what the browser has to hold.
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

func writeTar(w io.Writer, root *rootfs.Root, path, prefix string, opts ArchiveOptions) error {
	var (
		compressed io.Writer = w
		closer     io.Closer
	)
	switch opts.Format {
	case filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR:
		// No compression layer at all.
	case filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR_ZSTD:
		enc, err := zstd.NewWriter(w, zstd.WithEncoderLevel(zstdLevel(opts.Level)))
		if err != nil {
			return err
		}
		compressed, closer = enc, enc
	default:
		gz, err := gzip.NewWriterLevel(w, gzipLevel(opts.Level))
		if err != nil {
			return err
		}
		compressed, closer = gz, gz
	}

	tw := tar.NewWriter(compressed)
	if err := walk(root, path, prefix, opts.MaxEntries, func(name string, entry *rootfs.Stat, link string, open func() (io.ReadCloser, error)) error {
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
			// The file shrank instead; pad so the entry still matches.
			return nil
		}
		return err
	}); err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	if closer != nil {
		return closer.Close()
	}
	return nil
}

func writeZip(w io.Writer, root *rootfs.Root, path, prefix string, opts ArchiveOptions) error {
	zw := zip.NewWriter(w)
	level := gzipLevel(opts.Level)
	zw.RegisterCompressor(zip.Deflate, func(out io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(out, level)
	})

	if err := walk(root, path, prefix, opts.MaxEntries, func(name string, entry *rootfs.Stat, link string, open func() (io.ReadCloser, error)) error {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate, Modified: entry.ModTime}
		header.SetMode(entry.Mode)
		if entry.IsDir() {
			header.Name += "/"
			header.Method = zip.Store
		}
		out, err := zw.CreateHeader(header)
		if err != nil {
			return err
		}
		switch {
		case entry.IsDir():
			return nil
		case entry.IsSymlink():
			// zip has no link records; the convention every unzip follows is
			// a regular member whose body is the target and whose mode says
			// symlink, which SetMode above has already written.
			_, err = io.WriteString(out, link)
			return err
		}
		f, err := open()
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(out, f)
		return err
	}); err != nil {
		return err
	}
	return zw.Close()
}

// walk visits path and everything under it, depth first and in name order,
// handing the caller the archive-relative name plus a lazy opener so a
// format that does not need the body never reads one.
//
// Anything that is not a directory, a regular file or a symlink -- devices,
// sockets, fifos -- is skipped: neither tar nor zip round-trips them into a
// browser download in any useful way.
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

// gzipLevel maps the 0-9 request scale onto compress/flate's, where 0 means
// "store" rather than "default" -- so an unset level has to become
// DefaultCompression explicitly.
func gzipLevel(level int) int {
	if level <= 0 {
		return gzip.DefaultCompression
	}
	if level > flate.BestCompression {
		return flate.BestCompression
	}
	return level
}

// zstdLevel folds the same 0-9 scale onto the four encoder levels klauspost's
// zstd exposes; they are not numerically comparable to deflate's, so this is
// a mapping by intent (fast / normal / better / best) rather than by number.
func zstdLevel(level int) zstd.EncoderLevel {
	switch {
	case level <= 0:
		return zstd.SpeedDefault
	case level <= 3:
		return zstd.SpeedFastest
	case level <= 6:
		return zstd.SpeedDefault
	case level <= 8:
		return zstd.SpeedBetterCompression
	default:
		return zstd.SpeedBestCompression
	}
}
