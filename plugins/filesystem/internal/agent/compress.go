package agent

import (
	"archive/tar"
	"archive/zip"
	"compress/flate"
	"compress/gzip"
	"errors"
	"io"
	"strings"

	"github.com/klauspost/compress/zstd"

	filesystemv1 "console-filesystem-plugin/gen/filesystem/v1"
)

// Compression lives here, in the agent, rather than in the helper that reads
// the files.
//
// The helper is a process sitting inside a container's mount namespace; the
// less it does, the shorter it needs to live and the less there is to reason
// about while it is there. Walking a tree and framing a tar is syscalls;
// deflate and zstd are where a pathological input costs CPU and memory. So
// the helper streams an uncompressed tar and this side wraps it -- which also
// means a folder download is compressed before it crosses to the plugin
// backend, the console and the browser, which was the point of compressing on
// the node at all.
//
// zip is not a wrapper around tar, so it is transcoded entry by entry. That
// is still fully streaming: one tar header in, one zip entry out.

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
// directory's own name plus the format's suffix, or "root" for "/", which has
// no name of its own.
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

// compressStream reads the helper's uncompressed tar from src and writes the
// requested format to dst.
func compressStream(dst io.Writer, src io.Reader, format filesystemv1.ArchiveFormat, level int) error {
	switch format {
	case filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR:
		_, err := io.Copy(dst, src)
		return err

	case filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_ZIP:
		return tarToZip(dst, src, level)

	case filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR_ZSTD:
		encoder, err := zstd.NewWriter(dst, zstd.WithEncoderLevel(zstdLevel(level)))
		if err != nil {
			return err
		}
		if _, err := io.Copy(encoder, src); err != nil {
			_ = encoder.Close()
			return err
		}
		return encoder.Close()

	default:
		writer, err := gzip.NewWriterLevel(dst, gzipLevel(level))
		if err != nil {
			return err
		}
		if _, err := io.Copy(writer, src); err != nil {
			_ = writer.Close()
			return err
		}
		return writer.Close()
	}
}

// tarToZip rewrites a tar stream as a zip archive without holding either
// whole: each member is read from the tar and written straight into the zip.
func tarToZip(dst io.Writer, src io.Reader, level int) error {
	zw := zip.NewWriter(dst)
	flateLevel := gzipLevel(level)
	zw.RegisterCompressor(zip.Deflate, func(out io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(out, flateLevel)
	})

	reader := tar.NewReader(src)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return zw.Close()
		}
		if err != nil {
			return err
		}

		mode := header.FileInfo().Mode()
		entry := &zip.FileHeader{Name: header.Name, Method: zip.Deflate, Modified: header.ModTime}
		entry.SetMode(mode)

		switch header.Typeflag {
		case tar.TypeDir:
			entry.Method = zip.Store
			if !strings.HasSuffix(entry.Name, "/") {
				entry.Name += "/"
			}
			if _, err := zw.CreateHeader(entry); err != nil {
				return err
			}
		case tar.TypeSymlink:
			// zip has no link record; the convention every unzip follows is a
			// regular member whose body is the target and whose mode says
			// symlink, which SetMode has already written.
			out, err := zw.CreateHeader(entry)
			if err != nil {
				return err
			}
			if _, err := io.WriteString(out, header.Linkname); err != nil {
				return err
			}
		case tar.TypeReg:
			out, err := zw.CreateHeader(entry)
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, reader); err != nil {
				return err
			}
		default:
			// The helper never emits anything else.
			continue
		}
	}
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
