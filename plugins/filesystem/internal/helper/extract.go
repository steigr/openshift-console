package helper

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"

	"github.com/klauspost/compress/zstd"

	"console-filesystem-plugin/internal/rootfs"
)

// ErrArchiveTooBig ends an extraction that would write more than the agent
// allows -- the defence against an archive that unpacks to far more than it
// weighs.
var ErrArchiveTooBig = errors.New("archive unpacks to more than the agent's limit")

// ErrUnknownArchive is returned for a file that is none of the supported
// formats.
var ErrUnknownArchive = errors.New("not a zip, tar, tar.gz or tar.zst archive")

// ExtractLimits bound what one Extract call may write.
type ExtractLimits struct {
	MaxEntries int
	MaxBytes   int64
}

type archiveKind int

const (
	kindUnknown archiveKind = iota
	kindZip
	kindTar
	kindTarGz
	kindTarZstd
)

// detect identifies the archive from its leading bytes. The filename is only
// consulted for the tar case, whose magic sits 257 bytes in and is missing
// from some older writers; everything else is unambiguous from its magic, and
// trusting an extension over a magic number is how a "zip" full of something
// else gets opened as a zip.
func detect(head []byte, name string) archiveKind {
	switch {
	case bytes.HasPrefix(head, []byte("PK\x03\x04")), bytes.HasPrefix(head, []byte("PK\x05\x06")):
		return kindZip
	case bytes.HasPrefix(head, []byte{0x1f, 0x8b}):
		return kindTarGz
	case bytes.HasPrefix(head, []byte{0x28, 0xb5, 0x2f, 0xfd}):
		return kindTarZstd
	case len(head) >= 262 && bytes.HasPrefix(head[257:], []byte("ustar")):
		return kindTar
	}
	if strings.HasSuffix(name, ".tar") {
		return kindTar
	}
	return kindUnknown
}

// archiveSuffixes are stripped to derive a default destination, longest
// first so ".tar.gz" does not leave a dangling ".tar".
var archiveSuffixes = []string{".tar.zst", ".tar.zstd", ".tar.gz", ".tgz", ".tzst", ".tar", ".zip"}

// DefaultDestination is where an archive unpacks when the caller names no
// destination: a sibling directory named after the archive with its suffix
// removed, so "/srv/app.tar.gz" becomes "/srv/app".
func DefaultDestination(archivePath string) string {
	cleaned := "/" + strings.Trim(archivePath, "/")
	lower := strings.ToLower(cleaned)
	for _, suffix := range archiveSuffixes {
		if strings.HasSuffix(lower, suffix) {
			return cleaned[:len(cleaned)-len(suffix)]
		}
	}
	return cleaned + ".extracted"
}

// Extract unpacks archivePath into dest, both inside the container.
//
// Every member is written through the same root handle the rest of the agent
// uses, so no member can land outside the container however its name is
// spelled; safeName additionally keeps it inside dest, which RESOLVE_IN_ROOT
// alone would not (it clamps at the container root, not at the destination).
func Extract(root *rootfs.Root, archivePath, dest string, overwrite bool, limits ExtractLimits) (int64, error) {
	file, err := root.Open(archivePath)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	st, err := root.Stat(archivePath)
	if err != nil {
		return 0, err
	}
	if !st.IsRegular() {
		return 0, fmt.Errorf("%s is not a regular file", archivePath)
	}

	head := make([]byte, 512)
	n, err := io.ReadFull(file, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return 0, err
	}
	head = head[:n]
	kind := detect(head, strings.ToLower(archivePath))
	if kind == kindUnknown {
		return 0, ErrUnknownArchive
	}

	if err := root.MkdirAll(dest, 0o755); err != nil {
		return 0, err
	}

	if kind == kindZip {
		reader, err := zip.NewReader(file, st.Size)
		if err != nil {
			return 0, err
		}
		return extractZip(root, reader, dest, overwrite, limits)
	}

	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return 0, err
	}
	var stream io.Reader = file
	switch kind {
	case kindTarGz:
		gz, err := gzip.NewReader(file)
		if err != nil {
			return 0, err
		}
		defer gz.Close()
		stream = gz
	case kindTarZstd:
		dec, err := zstd.NewReader(file)
		if err != nil {
			return 0, err
		}
		defer dec.Close()
		stream = dec
	}
	return extractTar(root, tar.NewReader(stream), dest, overwrite, limits)
}

func extractTar(root *rootfs.Root, reader *tar.Reader, dest string, overwrite bool, limits ExtractLimits) (int64, error) {
	// Counted in entries, which is what the caller reports back to the user.
	var written int64
	budget := limits.MaxBytes
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return written, nil
		}
		if err != nil {
			return written, err
		}
		name, err := safeName(header.Name)
		if err != nil {
			return written, err
		}
		if name == "" {
			continue
		}
		if limits.MaxEntries > 0 && written >= int64(limits.MaxEntries) {
			return written, fmt.Errorf("%w: more than %d entries", ErrArchiveTooBig, limits.MaxEntries)
		}

		target := rootfs.Join(dest, name)
		mode := header.FileInfo().Mode()
		switch header.Typeflag {
		case tar.TypeDir:
			if err := root.MkdirAll(target, mode.Perm()); err != nil {
				return written, err
			}
		case tar.TypeSymlink:
			if err := writeSymlink(root, target, header.Linkname, overwrite); err != nil {
				return written, err
			}
		case tar.TypeReg:
			if _, err := writeFile(root, target, mode.Perm(), reader, overwrite, &budget); err != nil {
				return written, err
			}
		default:
			// Devices, fifos, hard links: skipped, as WriteArchive never
			// produces them and creating them would need privileges this
			// unpack has no business using.
			continue
		}
		if !header.ModTime.IsZero() {
			_ = root.Chtimes(target, header.ModTime, header.ModTime)
		}
		written++
	}
}

func extractZip(root *rootfs.Root, reader *zip.Reader, dest string, overwrite bool, limits ExtractLimits) (int64, error) {
	var written int64
	budget := limits.MaxBytes
	for _, member := range reader.File {
		name, err := safeName(member.Name)
		if err != nil {
			return written, err
		}
		if name == "" {
			continue
		}
		if limits.MaxEntries > 0 && written >= int64(limits.MaxEntries) {
			return written, fmt.Errorf("%w: more than %d entries", ErrArchiveTooBig, limits.MaxEntries)
		}

		target := rootfs.Join(dest, name)
		mode := member.Mode()
		switch {
		case member.FileInfo().IsDir():
			if err := root.MkdirAll(target, mode.Perm()); err != nil {
				return written, err
			}
		case mode&fs.ModeSymlink != 0:
			body, err := member.Open()
			if err != nil {
				return written, err
			}
			link, err := io.ReadAll(io.LimitReader(body, 4096))
			body.Close()
			if err != nil {
				return written, err
			}
			if err := writeSymlink(root, target, string(link), overwrite); err != nil {
				return written, err
			}
		case mode.IsRegular():
			body, err := member.Open()
			if err != nil {
				return written, err
			}
			_, err = writeFile(root, target, mode.Perm(), body, overwrite, &budget)
			body.Close()
			if err != nil {
				return written, err
			}
		default:
			continue
		}
		if !member.Modified.IsZero() {
			_ = root.Chtimes(target, member.Modified, member.Modified)
		}
		written++
	}
	return written, nil
}

func writeFile(root *rootfs.Root, target string, perm fs.FileMode, src io.Reader, overwrite bool, budget *int64) (int64, error) {
	if dir := path.Dir(target); dir != "" && dir != "." {
		if err := root.MkdirAll(dir, 0o755); err != nil {
			return 0, err
		}
	}
	if !overwrite {
		if _, err := root.Lstat(target); err == nil {
			return 0, fmt.Errorf("%s already exists: extract with overwrite to replace it", target)
		}
	}
	if perm == 0 {
		perm = 0o644
	}
	out, err := root.OpenWrite(target, perm, true)
	if err != nil {
		return 0, err
	}
	defer out.Close()

	limit := *budget
	if limit <= 0 {
		limit = int64(1) << 62
	}
	// One extra byte, so a source that exactly fills the budget is still
	// distinguishable from one that overruns it.
	n, err := io.Copy(out, io.LimitReader(src, limit+1))
	if err != nil {
		return n, err
	}
	if n > limit {
		return n, ErrArchiveTooBig
	}
	if *budget > 0 {
		*budget -= n
	}
	return n, nil
}

func writeSymlink(root *rootfs.Root, target, link string, overwrite bool) error {
	if dir := path.Dir(target); dir != "" && dir != "." {
		if err := root.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	if _, err := root.Lstat(target); err == nil {
		if !overwrite {
			return fmt.Errorf("%s already exists: extract with overwrite to replace it", target)
		}
		if err := root.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return root.Symlink(link, target)
}

// safeName normalizes an archive member's name and refuses anything that
// would place it outside the destination -- the "zip slip" family, which
// includes absolute names, "..", Windows-style backslash separators and
// names carrying a NUL.
//
// It returns ("", nil) for a name that normalizes to the destination itself,
// which archives routinely carry as a "./" member.
func safeName(name string) (string, error) {
	if strings.ContainsRune(name, 0) {
		return "", fmt.Errorf("archive member name contains a NUL byte")
	}
	name = strings.ReplaceAll(name, "\\", "/")
	if strings.HasPrefix(name, "/") {
		return "", fmt.Errorf("archive member %q is an absolute path", name)
	}
	cleaned := path.Clean(name)
	if cleaned == "." || cleaned == "/" {
		return "", nil
	}
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("archive member %q points outside the destination", name)
	}
	return cleaned, nil
}
