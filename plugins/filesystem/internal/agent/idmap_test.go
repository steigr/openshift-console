package agent

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func writeMaps(t *testing.T, uid, gid string) (procRoot string, pid int) {
	t.Helper()
	procRoot = t.TempDir()
	pid = 4711
	dir := filepath.Join(procRoot, strconv.Itoa(pid))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "uid_map"), []byte(uid), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "gid_map"), []byte(gid), 0o644); err != nil {
		t.Fatal(err)
	}
	return procRoot, pid
}

// A pod without a user namespace carries the full identity map, and must cost
// nothing afterwards.
func TestLoadIDMapsIdentityIsNil(t *testing.T) {
	procRoot, pid := writeMaps(t,
		"         0          0 4294967295\n",
		"         0          0 4294967295\n")

	uidMap, gidMap := LoadIDMaps(procRoot, pid)
	if uidMap != nil || gidMap != nil {
		t.Fatalf("identity maps should be nil, got %v/%v", uidMap, gidMap)
	}
	if uidMap.ToContainer(1000) != 1000 {
		t.Error("a nil map must translate to itself")
	}
}

// hostUsers: false. The container's 0 is some unprivileged id on the node, and
// the Info dialog must show what the container sees, not what the node does.
func TestLoadIDMapsTranslatesAShiftedNamespace(t *testing.T) {
	procRoot, pid := writeMaps(t,
		"         0     100000      65536\n",
		"         0     100000      65536\n")

	uidMap, gidMap := LoadIDMaps(procRoot, pid)
	if uidMap == nil || gidMap == nil {
		t.Fatal("a shifted map must not be treated as the identity")
	}
	for host, want := range map[uint32]uint32{100000: 0, 100001: 1, 101000: 1000, 165535: 65535} {
		if got := uidMap.ToContainer(host); got != want {
			t.Errorf("ToContainer(%d) = %d, want %d", host, got, want)
		}
	}
	// Round trip.
	if got := uidMap.ToHost(1000); got != 101000 {
		t.Errorf("ToHost(1000) = %d, want 101000", got)
	}
	// An id outside every range belongs to nobody inside the container; it is
	// shown as it is rather than invented.
	if got := uidMap.ToContainer(7); got != 7 {
		t.Errorf("an unmapped id should pass through, got %d", got)
	}
}

func TestLoadIDMapsHandlesMultipleRangesAndJunk(t *testing.T) {
	procRoot, pid := writeMaps(t,
		"0 100000 1000\nnot a mapping\n2000 200000 500\n",
		"0 100000 1000\n")

	uidMap, _ := LoadIDMaps(procRoot, pid)
	if uidMap == nil {
		t.Fatal("expected a map")
	}
	if got := uidMap.ToContainer(200010); got != 2010 {
		t.Errorf("second range: ToContainer(200010) = %d, want 2010", got)
	}
	if got := uidMap.ToContainer(100005); got != 5 {
		t.Errorf("first range: ToContainer(100005) = %d, want 5", got)
	}
}

// A kernel without user namespaces has no uid_map at all.
func TestLoadIDMapsWithoutTheFile(t *testing.T) {
	uidMap, gidMap := LoadIDMaps(t.TempDir(), 1)
	if uidMap != nil || gidMap != nil {
		t.Fatal("a missing uid_map is the identity mapping by another name")
	}
}
