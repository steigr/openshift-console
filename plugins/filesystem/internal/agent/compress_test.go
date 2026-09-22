package agent

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/klauspost/compress/zstd"

	filesystemv1 "console-filesystem-plugin/gen/filesystem/v1"
	"console-filesystem-plugin/internal/helper"
	"console-filesystem-plugin/internal/rootfs"
)

// sampleTar is what a helper streams: an uncompressed tar of a small tree
// with a directory, two files and a symlink.
func sampleTar(t *testing.T) []byte {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "app", "conf"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app", "README"), []byte("read me"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app", "conf", "settings.ini"), []byte("key=value\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/app/README", filepath.Join(dir, "app", "readme-link")); err != nil {
		t.Fatal(err)
	}
	root, err := rootfs.Sandbox(dir)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := helper.WriteTar(&buf, root, "/app", helper.ArchiveOptions{}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func tarNames(t *testing.T, r io.Reader) []string {
	t.Helper()
	var names []string
	reader := tar.NewReader(r)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			return names
		}
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, header.Name)
	}
}

// Every format must carry the same members through, since the frontend offers
// them as interchangeable ways to download one folder.
func TestCompressStreamPreservesMembers(t *testing.T) {
	source := sampleTar(t)
	want := tarNames(t, bytes.NewReader(source))
	sort.Strings(want)

	t.Run("tar", func(t *testing.T) {
		var out bytes.Buffer
		if err := compressStream(&out, bytes.NewReader(source), filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR, 0); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(out.Bytes(), source) {
			t.Error("the uncompressed format must pass the helper's stream through untouched")
		}
	})

	t.Run("tar.gz", func(t *testing.T) {
		var out bytes.Buffer
		if err := compressStream(&out, bytes.NewReader(source), filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR_GZ, 6); err != nil {
			t.Fatal(err)
		}
		reader, err := gzip.NewReader(&out)
		if err != nil {
			t.Fatal(err)
		}
		got := tarNames(t, reader)
		sort.Strings(got)
		assertNames(t, got, want)
	})

	t.Run("tar.zst", func(t *testing.T) {
		var out bytes.Buffer
		if err := compressStream(&out, bytes.NewReader(source), filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR_ZSTD, 3); err != nil {
			t.Fatal(err)
		}
		decoder, err := zstd.NewReader(&out)
		if err != nil {
			t.Fatal(err)
		}
		defer decoder.Close()
		got := tarNames(t, decoder)
		sort.Strings(got)
		assertNames(t, got, want)
	})

	t.Run("zip", func(t *testing.T) {
		var out bytes.Buffer
		if err := compressStream(&out, bytes.NewReader(source), filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_ZIP, 6); err != nil {
			t.Fatal(err)
		}
		reader, err := zip.NewReader(bytes.NewReader(out.Bytes()), int64(out.Len()))
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, member := range reader.File {
			got = append(got, member.Name)
		}
		sort.Strings(got)
		assertNames(t, got, want)
	})
}

func assertNames(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("members = %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("members = %v, want %v", got, want)
		}
	}
}

// The zip transcode has to carry file bodies and symlink targets across, not
// just names -- a zip of empty entries would still pass a name comparison.
func TestZipTranscodeCarriesContentAndLinks(t *testing.T) {
	var out bytes.Buffer
	if err := compressStream(&out, bytes.NewReader(sampleTar(t)), filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_ZIP, 6); err != nil {
		t.Fatal(err)
	}
	reader, err := zip.NewReader(bytes.NewReader(out.Bytes()), int64(out.Len()))
	if err != nil {
		t.Fatal(err)
	}

	var sawFile, sawLink, sawDir bool
	for _, member := range reader.File {
		body, err := member.Open()
		if err != nil {
			t.Fatal(err)
		}
		content, err := io.ReadAll(body)
		body.Close()
		if err != nil {
			t.Fatal(err)
		}
		switch member.Name {
		case "app/README":
			sawFile = true
			if string(content) != "read me" {
				t.Errorf("README = %q", content)
			}
		case "app/readme-link":
			sawLink = true
			if member.Mode()&os.ModeSymlink == 0 {
				t.Errorf("the symlink lost its mode: %v", member.Mode())
			}
			if string(content) != "/app/README" {
				t.Errorf("symlink body = %q, want the target path", content)
			}
		case "app/", "app/conf/":
			sawDir = true
			if !member.FileInfo().IsDir() {
				t.Errorf("%s should be a directory entry", member.Name)
			}
		}
	}
	if !sawFile || !sawLink || !sawDir {
		t.Errorf("missing entry kinds: file=%v link=%v dir=%v", sawFile, sawLink, sawDir)
	}
}

func TestArchiveFilename(t *testing.T) {
	for _, tc := range []struct {
		path   string
		format filesystemv1.ArchiveFormat
		want   string
	}{
		{"/var/log", filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR_GZ, "log.tar.gz"},
		{"/var/log/", filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_ZIP, "log.zip"},
		{"/", filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR_ZSTD, "root.tar.zst"},
		{"/srv/data", filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR, "data.tar"},
	} {
		if got := ArchiveFilename(tc.path, tc.format); got != tc.want {
			t.Errorf("ArchiveFilename(%q,%v) = %q, want %q", tc.path, tc.format, got, tc.want)
		}
	}
}

func TestCompressionLevels(t *testing.T) {
	// 0 must mean "the codec's own default", not deflate's level 0, which is
	// "store" -- the distinction that makes an unset level behave sensibly.
	if gzipLevel(0) != gzip.DefaultCompression {
		t.Errorf("gzipLevel(0) = %d, want DefaultCompression", gzipLevel(0))
	}
	if gzipLevel(6) != 6 || gzipLevel(99) != 9 {
		t.Errorf("gzipLevel clamps wrongly: %d %d", gzipLevel(6), gzipLevel(99))
	}
	if zstdLevel(0) != zstd.SpeedDefault || zstdLevel(1) != zstd.SpeedFastest || zstdLevel(9) != zstd.SpeedBestCompression {
		t.Error("the 0-9 scale does not map onto zstd's four encoder levels as documented")
	}
}
