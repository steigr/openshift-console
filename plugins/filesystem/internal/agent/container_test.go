package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	containerID = "9f2c0f1a3b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7"
	otherID     = "1111111111111111111111111111111111111111111111111111111111111111"
)

// fakeProc writes the /proc/<pid>/cgroup files a node would have, so the
// resolver can be exercised without a container runtime.
func fakeProc(t *testing.T, cgroups map[int]string) string {
	return fakeProcWithNamespaces(t, cgroups, nil)
}

// fakeProcWithNamespaces additionally gives each PID a /proc/<pid>/ns/mnt
// symlink, which is how the resolver tells a container's own processes from a
// supervisor sharing its cgroup.
func fakeProcWithNamespaces(t *testing.T, cgroups map[int]string, namespaces map[int]string) string {
	t.Helper()
	proc := t.TempDir()
	for pid, body := range cgroups {
		dir := filepath.Join(proc, itoa(pid))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "cgroup"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if ns, ok := namespaces[pid]; ok {
			if err := os.MkdirAll(filepath.Join(dir, "ns"), 0o755); err != nil {
				t.Fatal(err)
			}
			// A dangling symlink: only its target string is ever read, the
			// same way /proc/<pid>/ns/mnt reads as "mnt:[4026531832]".
			if err := os.Symlink(ns, filepath.Join(dir, "ns", "mnt")); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Non-numeric entries -- /proc is full of them -- must be ignored.
	if err := os.MkdirAll(filepath.Join(proc, "self"), 0o755); err != nil {
		t.Fatal(err)
	}
	return proc
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

func TestNormalizeContainerID(t *testing.T) {
	for _, in := range []string{
		"containerd://" + containerID,
		"cri-o://" + containerID,
		"docker://" + containerID,
		containerID,
	} {
		got, err := NormalizeContainerID(in)
		if err != nil || got != containerID {
			t.Errorf("NormalizeContainerID(%q) = %q, %v", in, got, err)
		}
	}

	// Anything that is not plain hex is refused: the ID is matched against
	// cgroup paths, and a value carrying separators could be made to match a
	// container the caller was never given.
	for _, in := range []string{"", "containerd://", "containerd://../../etc", "abc", "cri-o://xyz123456789"} {
		if _, err := NormalizeContainerID(in); err == nil {
			t.Errorf("NormalizeContainerID(%q) should have been refused", in)
		}
	}
}

func TestResolverFindsLowestPIDForCgroupV2(t *testing.T) {
	proc := fakeProc(t, map[int]string{
		1:    "0::/init.scope\n",
		4711: "0::/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod1234.slice/cri-containerd-" + containerID + ".scope\n",
		4712: "0::/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod1234.slice/cri-containerd-" + containerID + ".scope\n",
		4800: "0::/kubepods.slice/kubepods-besteffort.slice/cri-containerd-" + otherID + ".scope\n",
	})

	pid, err := NewResolver(proc, time.Minute).PID("containerd://" + containerID)
	if err != nil {
		t.Fatal(err)
	}
	if pid != 4711 {
		t.Errorf("pid = %d, want 4711 (the container's init, not a later process)", pid)
	}
}

func TestResolverHandlesCgroupV1AndCrio(t *testing.T) {
	proc := fakeProc(t, map[int]string{
		900: strings.Join([]string{
			"11:devices:/kubepods/burstable/pod1234/" + containerID,
			"5:cpuacct,cpu:/kubepods/burstable/pod1234/" + containerID,
			"",
		}, "\n"),
		950: "0::/kubepods.slice/kubepods-pod1234.slice/crio-" + otherID + ".scope\n",
	})

	resolver := NewResolver(proc, time.Minute)
	pid, err := resolver.PID(containerID)
	if err != nil || pid != 900 {
		t.Fatalf("cgroup v1 lookup = %d, %v", pid, err)
	}
	pid, err = resolver.PID("cri-o://" + otherID)
	if err != nil || pid != 950 {
		t.Fatalf("crio lookup = %d, %v", pid, err)
	}
}

func TestResolverRejectsPrefixMatches(t *testing.T) {
	// A container whose ID merely starts with the one asked for must not
	// match: IDs are compared as whole cgroup path tokens.
	proc := fakeProc(t, map[int]string{
		700: "0::/kubepods.slice/cri-containerd-" + containerID + "abcdef.scope\n",
	})
	if _, err := NewResolver(proc, time.Minute).PID(containerID); err == nil {
		t.Fatal("a longer container ID must not match a shorter one")
	}
}

func TestResolverReportsMissingContainer(t *testing.T) {
	proc := fakeProc(t, map[int]string{1: "0::/init.scope\n"})
	_, err := NewResolver(proc, time.Minute).PID(containerID)
	if err == nil {
		t.Fatal("expected an error for a container with no processes")
	}
	if !strings.Contains(err.Error(), "hostPID") {
		t.Errorf("the error should point at the likely cause, got %q", err)
	}
}

func TestResolverRevalidatesCachedPID(t *testing.T) {
	proc := fakeProc(t, map[int]string{
		500: "0::/kubepods.slice/cri-containerd-" + containerID + ".scope\n",
	})
	resolver := NewResolver(proc, time.Hour)
	if _, err := resolver.PID(containerID); err != nil {
		t.Fatal(err)
	}

	// The container restarts: same ID, different PID. Even inside the TTL the
	// cached PID must not be handed out, since PIDs are recycled and a stale
	// one points at whatever inherited the number.
	if err := os.WriteFile(filepath.Join(proc, "500", "cgroup"), []byte("0::/init.scope\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(proc, "610"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(proc, "610", "cgroup"),
		[]byte("0::/kubepods.slice/cri-containerd-"+containerID+".scope\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	pid, err := resolver.PID(containerID)
	if err != nil {
		t.Fatal(err)
	}
	if pid != 610 {
		t.Errorf("pid = %d, want 610: a cached PID whose cgroup no longer names the container must be rescanned", pid)
	}
}

func TestContainerRoot(t *testing.T) {
	if got := NewResolver("/proc", 0).ContainerRoot(42); got != "/proc/42/root" {
		t.Errorf("ContainerRoot = %q", got)
	}
}

// TestResolverIgnoresCrioConmon is a regression test for the bug that made the
// Files tab serve the *node's* root filesystem on a cri-o cluster.
//
// conmon is cri-o's per-container supervisor. It is placed in the container's
// own cgroup ("crio-conmon-<id>.scope"), so a cgroup scan finds it beside the
// container's real processes -- and it is started first, so it has the lower
// PID, which is exactly what the resolver used to prefer. It runs on the host
// though, in the host's mount namespace, so entering it looks entirely
// successful and browses the node.
//
// The layout below is copied from a real cri-o node, including the trailing
// "/container" segment on the container's own cgroup.
func TestResolverIgnoresCrioConmon(t *testing.T) {
	const (
		hostNS      = "mnt:[4026531832]"
		containerNS = "mnt:[4026541648]"
	)
	proc := fakeProcWithNamespaces(t,
		map[int]string{
			1:     "0::/init.scope\n",
			48105: "0::/system.slice/crio-conmon-" + containerID + ".scope\n",
			48107: "0::/kubepods.slice/kubepods-besteffort.slice/kubepods-besteffort-pod82ab430e_4231_430d_a929_32bef3ee740d.slice/crio-" + containerID + ".scope/container\n",
		},
		map[int]string{
			1:     hostNS,
			48105: hostNS,
			48107: containerNS,
		})

	pid, err := NewResolver(proc, time.Minute).PID("cri-o://" + containerID)
	if err != nil {
		t.Fatal(err)
	}
	if pid != 48107 {
		t.Fatalf("pid = %d, want 48107: %d is conmon, which shares the cgroup but runs in the node's mount namespace", pid, 48105)
	}
}

// The same rejection has to happen without the name "conmon" to go on, since
// other runtimes put their shim in the container's cgroup too.
func TestResolverIgnoresAnySupervisorInTheHostNamespace(t *testing.T) {
	const (
		hostNS      = "mnt:[4026531832]"
		containerNS = "mnt:[4026541648]"
	)
	proc := fakeProcWithNamespaces(t,
		map[int]string{
			1:   "0::/init.scope\n",
			500: "0::/kubepods.slice/cri-containerd-" + containerID + ".scope\n",
			900: "0::/kubepods.slice/cri-containerd-" + containerID + ".scope\n",
		},
		map[int]string{1: hostNS, 500: hostNS, 900: containerNS})

	pid, err := NewResolver(proc, time.Minute).PID(containerID)
	if err != nil {
		t.Fatal(err)
	}
	if pid != 900 {
		t.Fatalf("pid = %d, want 900: 500 is in the node's own mount namespace", pid)
	}
}

// A cached PID that turns out to be a host-namespace process must not be
// handed back either.
func TestResolverRevalidationRejectsHostNamespace(t *testing.T) {
	const hostNS = "mnt:[4026531832]"
	proc := fakeProcWithNamespaces(t,
		map[int]string{
			1:   "0::/init.scope\n",
			700: "0::/kubepods.slice/crio-" + containerID + ".scope\n",
		},
		map[int]string{1: hostNS, 700: hostNS})

	if _, err := NewResolver(proc, time.Minute).PID(containerID); err == nil {
		t.Fatal("the only candidate is in the node's mount namespace; that is not the container")
	}
}

// Without a readable /proc/1/ns/mnt there is nothing to compare against, and
// the scan must still work rather than rejecting everything.
func TestResolverWorksWithoutAHostNamespaceReference(t *testing.T) {
	proc := fakeProc(t, map[int]string{
		4711: "0::/kubepods.slice/crio-" + containerID + ".scope\n",
	})
	pid, err := NewResolver(proc, time.Minute).PID(containerID)
	if err != nil || pid != 4711 {
		t.Fatalf("pid = %d, err = %v", pid, err)
	}
}
