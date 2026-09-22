package agent_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	filesystemv1 "console-filesystem-plugin/gen/filesystem/v1"
	"console-filesystem-plugin/gen/filesystem/v1/filesystemv1connect"
	"console-filesystem-plugin/internal/agent"
	"console-filesystem-plugin/internal/wire"
)

const testContainerID = "aaaabbbbccccddddeeeeffff00001111222233334444555566667777888899990"

// serveAgent stands up the real agent handler over a fake /proc whose single
// process's "root" points at a directory standing in for a container image.
// Everything below then goes through the same code path a cluster would: the
// container ID header, the PID scan, the rootfs handle, the RPCs.
func serveAgent(t *testing.T) (filesystemv1connect.FileBrowserClient, http.Header, string) {
	t.Helper()

	container := t.TempDir()
	if err := os.MkdirAll(filepath.Join(container, "etc"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(container, "etc", "motd"), []byte("welcome\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	proc := t.TempDir()
	pidDir := filepath.Join(proc, "4711")
	if err := os.MkdirAll(pidDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pidDir, "cgroup"),
		[]byte("0::/kubepods.slice/cri-containerd-"+testContainerID+".scope\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// The kernel's magic /proc/<pid>/root, standing in as a symlink.
	if err := os.Symlink(container, filepath.Join(pidDir, "root")); err != nil {
		t.Fatal(err)
	}

	cfg := agent.DefaultConfig()
	cfg.ProcRoot = proc
	cfg.PIDCacheTTL = time.Minute

	handler, err := agent.Handler(agent.NewService(cfg), agent.ServeOptions{Token: "s3cret"})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	header := http.Header{}
	header.Set(wire.HeaderContainerID, "containerd://"+testContainerID)
	header.Set("Authorization", "Bearer s3cret")

	return filesystemv1connect.NewFileBrowserClient(server.Client(), server.URL), header, container
}

func request[T any](msg *T, header http.Header) *connect.Request[T] {
	req := connect.NewRequest(msg)
	for key, values := range header {
		req.Header()[http.CanonicalHeaderKey(key)] = values
	}
	return req
}

func TestAgentRejectsWrongToken(t *testing.T) {
	client, header, _ := serveAgent(t)
	header.Set("Authorization", "Bearer wrong")

	_, err := client.ListDirectory(context.Background(),
		request(&filesystemv1.ListDirectoryRequest{Path: "/"}, header))
	if err == nil {
		t.Fatal("the agent must refuse a caller that does not hold the shared token")
	}
}

func TestAgentRefusesWithoutContainerHeader(t *testing.T) {
	client, header, _ := serveAgent(t)
	header.Del(wire.HeaderContainerID)

	_, err := client.ListDirectory(context.Background(),
		request(&filesystemv1.ListDirectoryRequest{Path: "/"}, header))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("err = %v (code %v), want invalid_argument", err, connect.CodeOf(err))
	}
}

func TestAgentListsAndStats(t *testing.T) {
	client, header, _ := serveAgent(t)
	ctx := context.Background()

	list, err := client.ListDirectory(ctx, request(&filesystemv1.ListDirectoryRequest{Path: "/etc"}, header))
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Msg.GetEntries()) != 1 || list.Msg.GetEntries()[0].GetName() != "motd" {
		t.Fatalf("entries = %v", list.Msg.GetEntries())
	}
	if list.Msg.GetEntries()[0].GetType() != filesystemv1.EntryType_ENTRY_TYPE_FILE {
		t.Errorf("motd should be reported as a file")
	}

	stat, err := client.Stat(ctx, request(&filesystemv1.StatRequest{Path: "/etc/motd"}, header))
	if err != nil {
		t.Fatal(err)
	}
	if stat.Msg.GetEntry().GetSize() != 8 {
		t.Errorf("size = %d, want 8", stat.Msg.GetEntry().GetSize())
	}
}

func TestAgentUploadReadMoveDelete(t *testing.T) {
	client, header, _ := serveAgent(t)
	ctx := context.Background()

	// Two chunks, the way the frontend sends a file.
	for i, chunk := range []string{"hello ", "world"} {
		offset := int64(0)
		if i == 1 {
			offset = 6
		}
		resp, err := client.Upload(ctx, request(&filesystemv1.UploadRequest{
			Path:   "/etc/greeting",
			Offset: offset,
			Data:   []byte(chunk),
			Last:   i == 1,
			Mode:   0o644,
		}, header))
		if err != nil {
			t.Fatalf("upload chunk %d: %v", i, err)
		}
		if resp.Msg.GetBytesWritten() != int64(len(chunk)) {
			t.Errorf("chunk %d wrote %d bytes", i, resp.Msg.GetBytesWritten())
		}
	}

	stream, err := client.ReadFile(ctx, request(&filesystemv1.ReadFileRequest{Path: "/etc/greeting"}, header))
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

	if _, err := client.Move(ctx, request(&filesystemv1.MoveRequest{
		Source: "/etc/greeting", Destination: "/etc/motd",
	}, header)); err == nil {
		t.Fatal("a move onto an existing file must be refused without overwrite")
	}
	if _, err := client.Move(ctx, request(&filesystemv1.MoveRequest{
		Source: "/etc/greeting", Destination: "/etc/hello",
	}, header)); err != nil {
		t.Fatalf("move: %v", err)
	}

	if _, err := client.Delete(ctx, request(&filesystemv1.DeleteRequest{Path: "/etc/hello"}, header)); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := client.Stat(ctx, request(&filesystemv1.StatRequest{Path: "/etc/hello"}, header)); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("after delete, stat gave %v (code %v)", err, connect.CodeOf(err))
	}
}

func TestAgentArchiveStreamsAndNamesTheDownload(t *testing.T) {
	client, header, _ := serveAgent(t)

	stream, err := client.Archive(context.Background(), request(&filesystemv1.ArchiveRequest{
		Path:   "/etc",
		Format: filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR_ZSTD,
	}, header))
	if err != nil {
		t.Fatal(err)
	}
	var size int
	var filename string
	for stream.Receive() {
		size += len(stream.Msg().GetData())
		if name := stream.Msg().GetFilename(); name != "" {
			filename = name
		}
	}
	if err := stream.Err(); err != nil {
		t.Fatal(err)
	}
	if size == 0 {
		t.Fatal("the archive stream was empty")
	}
	if filename != "etc.tar.zst" {
		t.Errorf("filename = %q, want etc.tar.zst", filename)
	}
}

func TestAgentCreateDirectoryAndRecursiveDelete(t *testing.T) {
	client, header, _ := serveAgent(t)
	ctx := context.Background()

	if _, err := client.CreateDirectory(ctx, request(&filesystemv1.CreateDirectoryRequest{
		Path: "/srv/data/nested",
	}, header)); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Upload(ctx, request(&filesystemv1.UploadRequest{
		Path: "/srv/data/nested/file", Data: []byte("x"), Last: true,
	}, header)); err != nil {
		t.Fatal(err)
	}

	if _, err := client.Delete(ctx, request(&filesystemv1.DeleteRequest{Path: "/srv/data"}, header)); err == nil {
		t.Fatal("a non-empty directory must not be removed without recursive")
	}
	resp, err := client.Delete(ctx, request(&filesystemv1.DeleteRequest{Path: "/srv/data", Recursive: true}, header))
	if err != nil {
		t.Fatal(err)
	}
	if resp.Msg.GetEntriesRemoved() != 3 {
		t.Errorf("removed %d entries, want 3 (data, nested, file)", resp.Msg.GetEntriesRemoved())
	}
}

func TestAgentRefusesPathsLeavingTheContainer(t *testing.T) {
	client, header, container := serveAgent(t)

	// A secret next to the container root, reachable only by escaping it.
	if err := os.WriteFile(filepath.Join(filepath.Dir(container), "node-secret"), []byte("nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../node-secret", filepath.Join(container, "escape")); err != nil {
		t.Fatal(err)
	}

	// Listing shows the symlink -- that is just what is in the directory --
	// but following it must not reach the node's file.
	list, err := client.ListDirectory(context.Background(), request(&filesystemv1.ListDirectoryRequest{Path: "/"}, header))
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, entry := range list.Msg.GetEntries() {
		if entry.GetName() == "escape" {
			found = true
			if entry.GetTargetIsDirectory() {
				t.Error("an escaping symlink resolves to nothing inside the container")
			}
		}
	}
	if !found {
		t.Fatal("the symlink itself should still be listed")
	}

	stream, err := client.ReadFile(context.Background(), request(&filesystemv1.ReadFileRequest{Path: "/escape"}, header))
	if err == nil {
		var body strings.Builder
		for stream.Receive() {
			body.Write(stream.Msg().GetData())
		}
		err = stream.Err()
		if err == nil {
			t.Fatalf("reading through an escaping symlink returned %q instead of failing", body.String())
		}
	}
}
