package helper_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"

	filesystemv1 "console-filesystem-plugin/gen/filesystem/v1"
	"console-filesystem-plugin/gen/filesystem/v1/filesystemv1connect"
	"console-filesystem-plugin/internal/helper"
	"console-filesystem-plugin/internal/rootfs"
)

// serveHelper stands up the helper's real service over a sandbox root.
//
// In a cluster the root is "/" of a process that has joined a container's
// mount namespace; a test cannot join one, so it points the same service at a
// directory instead. Everything below the root resolution -- the RPC surface,
// the limits, the error codes -- is the code that ships.
func serveHelper(t *testing.T) (filesystemv1connect.FileBrowserClient, string) {
	t.Helper()

	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "etc"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "etc", "motd"), []byte("welcome\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	root, err := rootfs.Sandbox(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = root.Close() })

	path, handler := filesystemv1connect.NewFileBrowserHandler(
		helper.NewServiceWithRoot(helper.DefaultConfig(), root),
	)
	mux := http.NewServeMux()
	mux.Handle(path, handler)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	return filesystemv1connect.NewFileBrowserClient(server.Client(), server.URL), dir
}

func TestHelperListsAndStats(t *testing.T) {
	client, _ := serveHelper(t)
	ctx := context.Background()

	list, err := client.ListDirectory(ctx, connect.NewRequest(&filesystemv1.ListDirectoryRequest{Path: "/etc"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Msg.GetEntries()) != 1 || list.Msg.GetEntries()[0].GetName() != "motd" {
		t.Fatalf("entries = %v", list.Msg.GetEntries())
	}
	if list.Msg.GetEntries()[0].GetType() != filesystemv1.EntryType_ENTRY_TYPE_FILE {
		t.Error("motd should be reported as a file")
	}

	stat, err := client.Stat(ctx, connect.NewRequest(&filesystemv1.StatRequest{Path: "/etc/motd"}))
	if err != nil {
		t.Fatal(err)
	}
	if stat.Msg.GetEntry().GetSize() != 8 {
		t.Errorf("size = %d, want 8", stat.Msg.GetEntry().GetSize())
	}
}

func TestHelperUploadReadMoveDelete(t *testing.T) {
	client, _ := serveHelper(t)
	ctx := context.Background()

	// Two chunks, the way the frontend sends a file.
	for i, chunk := range []string{"hello ", "world"} {
		offset := int64(0)
		if i == 1 {
			offset = 6
		}
		resp, err := client.Upload(ctx, connect.NewRequest(&filesystemv1.UploadRequest{
			Path:   "/etc/greeting",
			Offset: offset,
			Data:   []byte(chunk),
			Last:   i == 1,
			Mode:   0o644,
		}))
		if err != nil {
			t.Fatalf("upload chunk %d: %v", i, err)
		}
		if resp.Msg.GetBytesWritten() != int64(len(chunk)) {
			t.Errorf("chunk %d wrote %d bytes", i, resp.Msg.GetBytesWritten())
		}
	}

	stream, err := client.ReadFile(ctx, connect.NewRequest(&filesystemv1.ReadFileRequest{Path: "/etc/greeting"}))
	if err != nil {
		t.Fatal(err)
	}
	var body strings.Builder
	var total int64
	for stream.Receive() {
		body.Write(stream.Msg().GetData())
		if stream.Msg().GetTotalSize() > 0 {
			total = stream.Msg().GetTotalSize()
		}
	}
	if err := stream.Err(); err != nil {
		t.Fatal(err)
	}
	if body.String() != "hello world" {
		t.Errorf("read back %q", body.String())
	}
	if total != 11 {
		t.Errorf("total size = %d, want 11", total)
	}

	if _, err := client.Move(ctx, connect.NewRequest(&filesystemv1.MoveRequest{
		Source: "/etc/greeting", Destination: "/etc/motd",
	})); err == nil {
		t.Fatal("a move onto an existing file must be refused without overwrite")
	}
	if _, err := client.Move(ctx, connect.NewRequest(&filesystemv1.MoveRequest{
		Source: "/etc/greeting", Destination: "/etc/hello",
	})); err != nil {
		t.Fatalf("move: %v", err)
	}

	if _, err := client.Delete(ctx, connect.NewRequest(&filesystemv1.DeleteRequest{Path: "/etc/hello"})); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := client.Stat(ctx, connect.NewRequest(&filesystemv1.StatRequest{Path: "/etc/hello"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("after delete, stat gave %v (code %v)", err, connect.CodeOf(err))
	}
}

// The helper produces tar and nothing else; asking it for a compressed format
// must fail rather than hand back something the agent would compress twice.
func TestHelperRefusesToCompress(t *testing.T) {
	client, _ := serveHelper(t)

	stream, err := client.Archive(context.Background(), connect.NewRequest(&filesystemv1.ArchiveRequest{
		Path:   "/etc",
		Format: filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR_GZ,
	}))
	if err == nil {
		for stream.Receive() {
		}
		err = stream.Err()
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("err = %v (code %v), want invalid_argument", err, connect.CodeOf(err))
	}
}

func TestHelperArchiveStreamsTar(t *testing.T) {
	client, _ := serveHelper(t)

	stream, err := client.Archive(context.Background(), connect.NewRequest(&filesystemv1.ArchiveRequest{
		Path:   "/etc",
		Format: filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR,
	}))
	if err != nil {
		t.Fatal(err)
	}
	var size int
	for stream.Receive() {
		size += len(stream.Msg().GetData())
	}
	if err := stream.Err(); err != nil {
		t.Fatal(err)
	}
	if size == 0 {
		t.Fatal("the archive stream was empty")
	}
	// The agent names the download; the helper deliberately does not.
	if size%512 != 0 {
		t.Errorf("a tar stream should be a whole number of 512-byte blocks, got %d", size)
	}
}

func TestHelperCreateDirectoryAndRecursiveDelete(t *testing.T) {
	client, _ := serveHelper(t)
	ctx := context.Background()

	if _, err := client.CreateDirectory(ctx, connect.NewRequest(&filesystemv1.CreateDirectoryRequest{
		Path: "/srv/data/nested",
	})); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Upload(ctx, connect.NewRequest(&filesystemv1.UploadRequest{
		Path: "/srv/data/nested/file", Data: []byte("x"), Last: true,
	})); err != nil {
		t.Fatal(err)
	}

	if _, err := client.Delete(ctx, connect.NewRequest(&filesystemv1.DeleteRequest{Path: "/srv/data"})); err == nil {
		t.Fatal("a non-empty directory must not be removed without recursive")
	}
	resp, err := client.Delete(ctx, connect.NewRequest(&filesystemv1.DeleteRequest{Path: "/srv/data", Recursive: true}))
	if err != nil {
		t.Fatal(err)
	}
	if resp.Msg.GetEntriesRemoved() != 3 {
		t.Errorf("removed %d entries, want 3 (data, nested, file)", resp.Msg.GetEntriesRemoved())
	}
}
