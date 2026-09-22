package agent

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"connectrpc.com/connect"

	filesystemv1 "console-filesystem-plugin/gen/filesystem/v1"
	"console-filesystem-plugin/internal/helper"
	"console-filesystem-plugin/internal/rootfs"
)

const testContainerID = "aaaabbbbccccddddeeeeffff00001111222233334444555566667777888899990"

// TestMain lets this test binary stand in for the helper.
//
// A unit test cannot join a mount namespace, so the child re-executes itself
// with FILESYSTEM_TEST_HELPER pointing at a directory and serves the real
// helper service over that sandbox. Everything the pool actually does --
// socketpair, fd inheritance, h2c over it, lifecycle, reaping -- is exercised
// for real; only the namespace entry is stubbed out.
func TestMain(m *testing.M) {
	if dir := os.Getenv("FILESYSTEM_TEST_HELPER"); dir != "" {
		root, err := rootfs.Sandbox(dir)
		if err != nil {
			os.Exit(1)
		}
		file := os.NewFile(uintptr(helper.ControlFD), "control")
		conn, err := net.FileConn(file)
		_ = file.Close()
		if err != nil {
			os.Exit(1)
		}
		_ = helper.ServeWithService(helper.NewServiceWithRoot(helper.DefaultConfig(), root), conn)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// testPool wires a pool to the stand-in helper above, watching a PID that is
// alive for the duration of the test (our own).
func testPool(t *testing.T, cfg Config) (*Pool, string) {
	t.Helper()

	sandbox := t.TempDir()
	if err := os.WriteFile(filepath.Join(sandbox, "marker"), []byte("inside\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// The fallback watcher (used off Linux) looks for /proc/<pid>; give it one
	// that exists so it does not decide the container has gone.
	fakeProc := t.TempDir()
	if err := os.MkdirAll(filepath.Join(fakeProc, strconv.Itoa(os.Getpid())), 0o755); err != nil {
		t.Fatal(err)
	}
	original := procRootForWatch
	procRootForWatch = fakeProc
	t.Cleanup(func() { procRootForWatch = original })

	cfg.ProcRoot = ""
	pool, err := NewPool(cfg)
	if err != nil {
		t.Fatal(err)
	}
	pool.resolvePID = func(string) (int, error) { return os.Getpid(), nil }
	pool.helperCommand = func(int) *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=TestNothingRunsHere")
		cmd.Env = append(os.Environ(), "FILESYSTEM_TEST_HELPER="+sandbox)
		return cmd
	}
	t.Cleanup(pool.Close)
	return pool, sandbox
}

func TestPoolSpawnsAHelperAndTalksToItOverTheSocketpair(t *testing.T) {
	pool, _ := testPool(t, DefaultConfig())

	h, err := pool.Acquire("containerd://" + testContainerID)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Release(h)

	resp, err := h.Client().ListDirectory(context.Background(),
		connect.NewRequest(&filesystemv1.ListDirectoryRequest{Path: "/"}))
	if err != nil {
		t.Fatalf("calling the helper: %v", err)
	}
	if len(resp.Msg.GetEntries()) != 1 || resp.Msg.GetEntries()[0].GetName() != "marker" {
		t.Fatalf("entries = %v", resp.Msg.GetEntries())
	}
}

func TestPoolReusesOneHelperPerContainer(t *testing.T) {
	pool, _ := testPool(t, DefaultConfig())

	first, err := pool.Acquire(testContainerID)
	if err != nil {
		t.Fatal(err)
	}
	pool.Release(first)

	second, err := pool.Acquire(testContainerID)
	if err != nil {
		t.Fatal(err)
	}
	pool.Release(second)

	if first != second {
		t.Fatal("a second call for the same container must reuse its helper, not spawn another")
	}
}

// The grace period is what keeps clicking around a tree from paying for a
// respawn -- and what bounds how long a helper holds a container's mount
// namespace after the user has gone.
func TestPoolStopsAHelperAfterTheGracePeriod(t *testing.T) {
	cfg := DefaultConfig()
	cfg.HelperGrace = 150 * time.Millisecond
	pool, _ := testPool(t, cfg)

	h, err := pool.Acquire(testContainerID)
	if err != nil {
		t.Fatal(err)
	}
	pid := h.cmd.Process.Pid
	pool.Release(h)

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		pool.mu.Lock()
		remaining := len(pool.helpers)
		pool.mu.Unlock()
		if remaining == 0 {
			// The process must actually be gone, not merely forgotten.
			if err := waitGone(pid); err != nil {
				t.Fatalf("helper pid %d outlived the pool: %v", pid, err)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the helper was still registered long after its grace period")
}

// An in-flight call holds the helper open regardless of the grace period; a
// download that takes a minute must not have its helper reaped underneath it.
func TestPoolKeepsAHelperWhileACallIsInFlight(t *testing.T) {
	cfg := DefaultConfig()
	cfg.HelperGrace = 50 * time.Millisecond
	pool, _ := testPool(t, cfg)

	h, err := pool.Acquire(testContainerID)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Release(h)

	time.Sleep(300 * time.Millisecond)

	pool.mu.Lock()
	remaining := len(pool.helpers)
	pool.mu.Unlock()
	if remaining != 1 {
		t.Fatalf("helpers = %d, want the in-flight one to have been kept", remaining)
	}
	if _, err := h.Client().ListDirectory(context.Background(),
		connect.NewRequest(&filesystemv1.ListDirectoryRequest{Path: "/"})); err != nil {
		t.Fatalf("the helper should still answer: %v", err)
	}
}

func TestPoolCapsHelpers(t *testing.T) {
	cfg := DefaultConfig()
	cfg.MaxHelpers = 1
	pool, _ := testPool(t, cfg)

	first, err := pool.Acquire(testContainerID)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Release(first)

	other := "1111111111111111111111111111111111111111111111111111111111111111"
	if _, err := pool.Acquire(other); err == nil {
		t.Fatal("a second container must be refused once the cap is reached")
	}
}

func TestPoolRejectsAMalformedContainerID(t *testing.T) {
	pool, _ := testPool(t, DefaultConfig())
	if _, err := pool.Acquire("containerd://../../etc"); err == nil {
		t.Fatal("a non-hexadecimal container ID must be refused before anything is spawned")
	}
}

// waitGone gives the killed process a moment to be reaped before failing.
func waitGone(pid int) error {
	deadline := time.Now().Add(2 * time.Second)
	var err error
	for time.Now().Before(deadline) {
		process, findErr := os.FindProcess(pid)
		if findErr != nil {
			return nil
		}
		if err = process.Signal(os.Signal(nil)); err != nil {
			return nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	return nil
}
