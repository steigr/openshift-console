package agent

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// IDMap translates a uid or gid between the node's numbering and a
// container's.
//
// It matters for pods that run in their own user namespace
// (`spec.hostUsers: false`). There, the container's uid 0 is some
// unprivileged id on the node -- and the helper, which joins only the mount
// namespace, reads the node's numbering. Without this, the Info dialog on
// such a pod reports "100000:100000" for a file the container itself calls
// "0:0".
//
// The helper cannot avoid this by joining the user namespace as well:
// setns(CLONE_NEWUSER) refuses a multithreaded caller with EINVAL, and the Go
// runtime is always multithreaded, so entering one would need the very
// re-exec machinery that unshare(CLONE_FS) let us avoid for the mount
// namespace. Translating afterwards costs a file read at spawn and a lookup
// per entry.
//
// A nil IDMap is the identity, which is what every pod without a user
// namespace gets.
type IDMap struct {
	ranges []idRange
}

type idRange struct {
	// container is the first id inside; host the first id outside; length
	// how many consecutive ids the pair covers. This is exactly a line of
	// /proc/<pid>/uid_map.
	container, host, length uint32
}

// LoadIDMaps reads the uid and gid maps of a process. Either result is nil
// when the mapping is the identity, so the common case costs nothing later.
func LoadIDMaps(procRoot string, pid int) (uidMap, gidMap *IDMap) {
	return loadIDMap(filepath.Join(procRoot, strconv.Itoa(pid), "uid_map")),
		loadIDMap(filepath.Join(procRoot, strconv.Itoa(pid), "gid_map"))
}

func loadIDMap(path string) *IDMap {
	file, err := os.Open(path)
	if err != nil {
		// No uid_map at all means no user namespaces on this kernel, which is
		// the identity mapping by another name.
		return nil
	}
	defer file.Close()

	var parsed IDMap
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 3 {
			continue
		}
		container, err1 := strconv.ParseUint(fields[0], 10, 32)
		host, err2 := strconv.ParseUint(fields[1], 10, 32)
		length, err3 := strconv.ParseUint(fields[2], 10, 32)
		if err1 != nil || err2 != nil || err3 != nil {
			continue
		}
		parsed.ranges = append(parsed.ranges, idRange{
			container: uint32(container),
			host:      uint32(host),
			length:    uint32(length),
		})
	}
	if parsed.isIdentity() {
		return nil
	}
	return &parsed
}

// isIdentity reports the "0 0 4294967295" every process outside a user
// namespace carries, plus any other mapping that happens to be a no-op.
func (m *IDMap) isIdentity() bool {
	for _, r := range m.ranges {
		if r.container != r.host {
			return false
		}
	}
	return true
}

// ToContainer turns an id as the node sees it into the id the container sees.
// An id outside every mapped range is returned unchanged: it belongs to no
// one inside the container (the kernel shows it as 65534, "nobody"), and
// inventing a number for it would be worse than showing the real one.
func (m *IDMap) ToContainer(host uint32) uint32 {
	if m == nil {
		return host
	}
	for _, r := range m.ranges {
		if host >= r.host && host-r.host < r.length {
			return r.container + (host - r.host)
		}
	}
	return host
}

// ToHost is the inverse, for an id the caller supplied.
func (m *IDMap) ToHost(container uint32) uint32 {
	if m == nil {
		return container
	}
	for _, r := range m.ranges {
		if container >= r.container && container-r.container < r.length {
			return r.host + (container - r.container)
		}
	}
	return container
}

func (m *IDMap) String() string {
	if m == nil {
		return "identity"
	}
	parts := make([]string, 0, len(m.ranges))
	for _, r := range m.ranges {
		parts = append(parts, fmt.Sprintf("%d:%d+%d", r.container, r.host, r.length))
	}
	return strings.Join(parts, ",")
}
