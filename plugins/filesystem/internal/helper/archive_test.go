package helper

import (
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"console-filesystem-plugin/internal/rootfs"
)

// tree builds a small container filesystem: a directory with a nested
// subdirectory, two files and a symlink, which between them exercise every
// entry kind WriteArchive knows how to emit.
func tree(t *testing.T) (*rootfs.Root, string) {
	t.Helper()
	dir := t.TempDir()
	mustMkdir(t, filepath.Join(dir, "app", "conf"))
	mustWrite(t, filepath.Join(dir, "app", "README"), "read me")
	mustWrite(t, filepath.Join(dir, "app", "conf", "settings.ini"), "[main]\nkey=value\n")
	if err := os.Symlink("/app/README", filepath.Join(dir, "app", "readme-link")); err != nil {
		t.Fatal(err)
	}
	root, err := rootfs.Sandbox(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = root.Close() })
	return root, dir
}

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestTarRoundTrip is the contract that matters for the two user-facing
// features at once: a folder download must produce an archive that this same
// helper's "uncompress" can unpack back into the identical tree.
//
// Only tar appears here. The helper never compresses -- the agent wraps this
// stream in gzip, zstd or a zip transcode (internal/agent/compress_test.go
// covers that half) -- so testing a compressed round trip here would be
// testing the wrong process.
func TestTarRoundTrip(t *testing.T) {
	root, _ := tree(t)

	var buf bytes.Buffer
	if err := WriteTar(&buf, root, "/app", ArchiveOptions{}); err != nil {
		t.Fatalf("writing tar: %v", err)
	}
	if buf.Len() == 0 {
		t.Fatal("archive is empty")
	}

	// Put the archive back inside the container and unpack it there, which is
	// exactly what the Extract RPC does.
	mustWriteInto(t, root, "/download.tar", buf.String())

	count, err := Extract(root, "/download.tar", "/unpacked", false, ExtractLimits{})
	if err != nil {
		t.Fatalf("extracting: %v", err)
	}
	if count == 0 {
		t.Fatal("extracted nothing")
	}

	readme, err := readAll(root, "/unpacked/app/README")
	if err != nil {
		t.Fatalf("reading unpacked README: %v", err)
	}
	if readme != "read me" {
		t.Errorf("README = %q", readme)
	}
	settings, err := readAll(root, "/unpacked/app/conf/settings.ini")
	if err != nil {
		t.Fatalf("reading unpacked settings.ini: %v", err)
	}
	if !strings.Contains(settings, "key=value") {
		t.Errorf("settings.ini = %q", settings)
	}
	link, err := root.Lstat("/unpacked/app/readme-link")
	if err != nil {
		t.Fatalf("lstat unpacked symlink: %v", err)
	}
	if !link.IsSymlink() {
		t.Errorf("the symlink came back as %v, not a symlink", link.Mode)
	}
}

func readAll(root *rootfs.Root, path string) (string, error) {
	file, err := root.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(file); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// TestExtractDetectsByMagic: the format is read off the bytes, not the
// filename, so a .zip that is really a tar.gz still unpacks.
func TestExtractDetectsByMagic(t *testing.T) {
	root, _ := tree(t)

	var tarred bytes.Buffer
	if err := WriteTar(&tarred, root, "/app", ArchiveOptions{}); err != nil {
		t.Fatal(err)
	}
	var gzipped bytes.Buffer
	writer := gzip.NewWriter(&gzipped)
	if _, err := writer.Write(tarred.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	mustWriteInto(t, root, "/misnamed.zip", gzipped.String())

	if _, err := Extract(root, "/misnamed.zip", "/out", false, ExtractLimits{}); err != nil {
		t.Fatalf("extracting a mislabelled archive: %v", err)
	}
}

func TestExtractRefusesUnknownFormat(t *testing.T) {
	root, _ := tree(t)
	mustWriteInto(t, root, "/notes.txt", "just some text, long enough not to look like a header at all")
	if _, err := Extract(root, "/notes.txt", "/out", false, ExtractLimits{}); err == nil {
		t.Fatal("a plain text file is not an archive and must be refused")
	}
}

func TestExtractRefusesToClobberUnlessAsked(t *testing.T) {
	root, _ := tree(t)

	var buf bytes.Buffer
	if err := WriteTar(&buf, root, "/app", ArchiveOptions{}); err != nil {
		t.Fatal(err)
	}
	mustWriteInto(t, root, "/a.tar", buf.String())

	if _, err := Extract(root, "/a.tar", "/dest", false, ExtractLimits{}); err != nil {
		t.Fatal(err)
	}
	if _, err := Extract(root, "/a.tar", "/dest", false, ExtractLimits{}); err == nil {
		t.Fatal("unpacking over existing files must be refused unless overwrite is asked for")
	}
	if _, err := Extract(root, "/a.tar", "/dest", true, ExtractLimits{}); err != nil {
		t.Fatalf("overwrite extract: %v", err)
	}
}

func TestExtractHonoursByteBudget(t *testing.T) {
	root, _ := tree(t)
	var buf bytes.Buffer
	if err := WriteTar(&buf, root, "/app", ArchiveOptions{}); err != nil {
		t.Fatal(err)
	}
	mustWriteInto(t, root, "/b.tar", buf.String())

	if _, err := Extract(root, "/b.tar", "/tiny", false, ExtractLimits{MaxBytes: 3}); err == nil {
		t.Fatal("an extraction past the byte budget must fail rather than truncate")
	}
}

func mustWriteInto(t *testing.T, root *rootfs.Root, path, body string) {
	t.Helper()
	file, err := root.OpenWrite(path, 0o644, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteAt([]byte(body), 0); err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
}

func TestSafeNameBlocksZipSlip(t *testing.T) {
	for _, name := range []string{"../etc/passwd", "/etc/passwd", "..\\..\\windows", "a/../../b", "x\x00y"} {
		if _, err := safeName(name); err == nil {
			t.Errorf("safeName(%q) should have been refused", name)
		}
	}
	got, err := safeName("./app/conf/settings.ini")
	if err != nil || got != "app/conf/settings.ini" {
		t.Errorf("safeName = %q, %v", got, err)
	}
	if got, err := safeName("./"); err != nil || got != "" {
		t.Errorf(`safeName("./") = %q, %v; a self-referential member is skipped, not an error`, got, err)
	}
}

func TestDefaultDestination(t *testing.T) {
	for in, want := range map[string]string{
		"/srv/app.tar.gz":  "/srv/app",
		"/srv/app.tar.zst": "/srv/app",
		"/srv/app.zip":     "/srv/app",
		"/srv/app.tgz":     "/srv/app",
		"/srv/app.tar":     "/srv/app",
		"/srv/app":         "/srv/app.extracted",
	} {
		if got := DefaultDestination(in); got != want {
			t.Errorf("DefaultDestination(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestArchiveSizeCap(t *testing.T) {
	root, _ := tree(t)
	var buf bytes.Buffer
	if err := WriteTar(&buf, root, "/app", ArchiveOptions{MaxBytes: 16}); err == nil {
		t.Fatal("an archive past the size cap must fail rather than arrive truncated")
	}
}
