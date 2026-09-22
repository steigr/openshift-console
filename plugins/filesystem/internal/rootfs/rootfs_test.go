package rootfs_test

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"console-filesystem-plugin/internal/rootfs"
)

// newRoot builds a throwaway "container filesystem" with the shapes that
// matter: an absolute symlink (which must resolve *inside* the root, the
// whole reason this package exists), one that tries to climb out, and a
// nested directory.
func newRoot(t *testing.T) (*rootfs.Root, string, string) {
	t.Helper()
	base := t.TempDir()
	inside := filepath.Join(base, "container")
	if err := os.MkdirAll(filepath.Join(inside, "etc"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inside, "etc", "hosts"), []byte("127.0.0.1 localhost\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "node-secret"), []byte("NODE SECRET"), 0o600); err != nil {
		t.Fatal(err)
	}
	// /link -> /etc : absolute, and a container image would have dozens.
	if err := os.Symlink("/etc", filepath.Join(inside, "link")); err != nil {
		t.Fatal(err)
	}
	// /escape -> ../node-secret : the attack this package blocks.
	if err := os.Symlink("../node-secret", filepath.Join(inside, "escape")); err != nil {
		t.Fatal(err)
	}
	root, err := rootfs.Open(inside)
	if err != nil {
		t.Fatalf("opening root: %v", err)
	}
	t.Cleanup(func() { _ = root.Close() })
	return root, inside, base
}

func TestAbsoluteSymlinkResolvesInsideRoot(t *testing.T) {
	root, _, _ := newRoot(t)

	file, err := root.Open("/link/hosts")
	if err != nil {
		t.Fatalf("an absolute symlink must resolve against the container root, got %v", err)
	}
	defer file.Close()

	body := make([]byte, 64)
	n, _ := file.Read(body)
	if !strings.Contains(string(body[:n]), "localhost") {
		t.Fatalf("read %q through /link/hosts", body[:n])
	}
}

func TestEscapingPathsAreRefused(t *testing.T) {
	root, _, _ := newRoot(t)

	for _, path := range []string{"/escape", "/../node-secret", "/etc/../../node-secret"} {
		if _, err := root.Open(path); err == nil {
			t.Fatalf("%s: expected the read to be refused", path)
		}
	}
}

func TestDotDotIsClampedAtRoot(t *testing.T) {
	root, _, _ := newRoot(t)

	// Climbing past the root lands on the root, exactly as it would in a
	// chroot -- so this resolves back to a file that does exist.
	file, err := root.Open("/etc/../../../etc/hosts")
	if err != nil {
		t.Fatalf("expected .. to clamp at the root, got %v", err)
	}
	_ = file.Close()
}

func TestListReportsTypesAndLinks(t *testing.T) {
	root, _, _ := newRoot(t)

	entries, truncated, err := root.List("/", 0)
	if err != nil {
		t.Fatal(err)
	}
	if truncated {
		t.Fatal("a four-entry directory should not be truncated")
	}

	byName := map[string]rootfs.Dirent{}
	for _, entry := range entries {
		byName[entry.Stat.Name] = entry
	}

	if !byName["etc"].Stat.IsDir() {
		t.Error("etc should be a directory")
	}
	link := byName["link"]
	if !link.Stat.IsSymlink() {
		t.Error("link should be a symlink")
	}
	if link.LinkTarget != "/etc" {
		t.Errorf("link target = %q, want /etc", link.LinkTarget)
	}
	if !link.TargetIsDir {
		t.Error("link points at a directory, so the tree should be able to expand it")
	}
	if byName["escape"].TargetIsDir {
		t.Error("an escaping symlink resolves to nothing, so it is not an expandable directory")
	}
}

func TestListTruncates(t *testing.T) {
	root, inside, _ := newRoot(t)
	for i := 0; i < 10; i++ {
		if err := os.WriteFile(filepath.Join(inside, "etc", "f"+string(rune('a'+i))), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	entries, truncated, err := root.List("/etc", 4)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 4 || !truncated {
		t.Fatalf("got %d entries truncated=%v, want 4 and true", len(entries), truncated)
	}
}

func TestWriteReadAndDelete(t *testing.T) {
	root, _, _ := newRoot(t)

	file, err := root.OpenWrite("/etc/new.txt", 0o640, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteAt([]byte("hello"), 0); err != nil {
		t.Fatal(err)
	}
	_ = file.Close()

	st, err := root.Lstat("/etc/new.txt")
	if err != nil {
		t.Fatal(err)
	}
	if st.Size != 5 {
		t.Errorf("size = %d, want 5", st.Size)
	}
	if st.Mode.Perm() != 0o640 {
		t.Errorf("mode = %v, want -rw-r-----", st.Mode)
	}

	if err := root.Remove("/etc/new.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := root.Lstat("/etc/new.txt"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("after remove, lstat gave %v", err)
	}
}

func TestRenameRefusesToClobberUnlessAsked(t *testing.T) {
	root, _, _ := newRoot(t)

	for _, name := range []string{"/a", "/b"} {
		f, err := root.OpenWrite(name, 0o644, true)
		if err != nil {
			t.Fatal(err)
		}
		_ = f.Close()
	}

	if err := root.Rename("/a", "/b", false); err == nil {
		t.Fatal("a move onto an existing name must be refused unless overwrite is asked for")
	}
	if err := root.Rename("/a", "/b", true); err != nil {
		t.Fatalf("overwrite move: %v", err)
	}
	if _, err := root.Lstat("/a"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("source should be gone, lstat gave %v", err)
	}
}

func TestMkdirAll(t *testing.T) {
	root, _, _ := newRoot(t)

	if err := root.MkdirAll("/var/lib/app", 0o755); err != nil {
		t.Fatal(err)
	}
	st, err := root.Lstat("/var/lib/app")
	if err != nil {
		t.Fatal(err)
	}
	if !st.IsDir() {
		t.Fatal("expected a directory")
	}
	// Idempotent, which is what an upload into an existing tree relies on.
	if err := root.MkdirAll("/var/lib/app", 0o755); err != nil {
		t.Fatalf("second MkdirAll: %v", err)
	}
}

func TestCleanPathAndSplitParent(t *testing.T) {
	for path, want := range map[string]string{"": ".", "/": ".", "/etc": "etc", "etc/": "etc/"} {
		got, err := rootfs.CleanPath(path)
		if err != nil || got != want {
			t.Errorf("CleanPath(%q) = %q, %v; want %q", path, got, err, want)
		}
	}
	if _, err := rootfs.CleanPath("a\x00b"); err == nil {
		t.Error("a NUL in a path must be refused")
	}

	dir, base, err := rootfs.SplitParent("/etc/hosts")
	if err != nil || dir != "etc" || base != "hosts" {
		t.Errorf("SplitParent = %q,%q,%v", dir, base, err)
	}
	if _, _, err := rootfs.SplitParent("/"); err == nil {
		t.Error("the root has no parent and must say so")
	}
}

func TestJoin(t *testing.T) {
	for _, tc := range []struct{ dir, name, want string }{
		{"/", "etc", "/etc"},
		{"/var", "log", "/var/log"},
		{"/var/", "log", "/var/log"},
	} {
		if got := rootfs.Join(tc.dir, tc.name); got != tc.want {
			t.Errorf("Join(%q,%q) = %q, want %q", tc.dir, tc.name, got, tc.want)
		}
	}
}
