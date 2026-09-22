package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Resolver turns a CRI container ID into a process ID on this node, which is
// the only handle that leads to a container's filesystem: /proc/<pid>/root is
// resolved by the kernel in that process's mount namespace.
//
// It finds the PID by scanning /proc rather than by asking the container
// runtime. Talking CRI would mean knowing which runtime is installed, where
// its socket is, mounting that socket into this pod and pulling in the
// k8s.io/cri-api and grpc-go dependency trees -- for one number that every
// runtime already writes into a place this pod can read. A container's
// cgroup path contains its own ID under containerd ("cri-containerd-<id>.scope"
// or ".../<id>"), CRI-O ("crio-<id>.scope") and Docker alike, so one pass over
// /proc/*/cgroup identifies every process in the container, on cgroup v1 and
// v2 both. This does require hostPID, which the agent needs regardless.
type Resolver struct {
	// procRoot is "/proc" outside tests.
	procRoot string
	// ttl bounds how long a resolved PID is reused. Short, because a
	// container that restarts keeps its ID while its PID changes.
	ttl time.Duration

	mu    sync.Mutex
	cache map[string]cacheEntry
	now   func() time.Time
}

type cacheEntry struct {
	pid     int
	expires time.Time
}

func NewResolver(procRoot string, ttl time.Duration) *Resolver {
	if procRoot == "" {
		procRoot = "/proc"
	}
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	return &Resolver{
		procRoot: procRoot,
		ttl:      ttl,
		cache:    map[string]cacheEntry{},
		now:      time.Now,
	}
}

// NormalizeContainerID strips the runtime scheme kubelet puts in front of the
// ID it reports in a pod's containerStatuses ("containerd://", "cri-o://",
// "docker://"), leaving the ID the cgroup hierarchy is named after.
func NormalizeContainerID(id string) (string, error) {
	if i := strings.Index(id, "://"); i >= 0 {
		id = id[i+3:]
	}
	if id == "" {
		return "", fmt.Errorf("empty container ID")
	}
	// Runtimes use lowercase hex; anything else is either a different
	// runtime's format or an injected value, and matching it against cgroup
	// paths as a substring would be a way to reach an unintended container.
	for _, c := range id {
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return "", fmt.Errorf("container ID %q is not hexadecimal", id)
		}
	}
	if len(id) < 12 {
		return "", fmt.Errorf("container ID %q is too short", id)
	}
	return id, nil
}

// PID returns the lowest PID whose cgroup names this container -- the
// container's init process, which is the one guaranteed to still be in the
// container's own mount namespace (a process that has unshared its own would
// sort later).
func (r *Resolver) PID(containerID string) (int, error) {
	id, err := NormalizeContainerID(containerID)
	if err != nil {
		return 0, err
	}

	r.mu.Lock()
	entry, ok := r.cache[id]
	r.mu.Unlock()
	if ok && r.now().Before(entry.expires) && r.pidMatches(entry.pid, id) {
		return entry.pid, nil
	}

	pid, err := r.scan(id)
	if err != nil {
		r.mu.Lock()
		delete(r.cache, id)
		r.mu.Unlock()
		return 0, err
	}

	r.mu.Lock()
	r.cache[id] = cacheEntry{pid: pid, expires: r.now().Add(r.ttl)}
	r.mu.Unlock()
	return pid, nil
}

// pidMatches re-checks a cached PID before it is reused: PIDs are recycled,
// and handing out a stale one would point the browser at whatever container
// inherited the number.
func (r *Resolver) pidMatches(pid int, id string) bool {
	data, err := os.ReadFile(filepath.Join(r.procRoot, strconv.Itoa(pid), "cgroup"))
	if err != nil {
		return false
	}
	return cgroupNames(string(data), id)
}

func (r *Resolver) scan(id string) (int, error) {
	entries, err := os.ReadDir(r.procRoot)
	if err != nil {
		return 0, fmt.Errorf("reading %s: %w", r.procRoot, err)
	}

	pids := make([]int, 0, 8)
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 0 {
			continue
		}
		data, err := os.ReadFile(filepath.Join(r.procRoot, entry.Name(), "cgroup"))
		if err != nil {
			// Processes come and go while /proc is being read; so do
			// permission errors on a non-privileged run.
			continue
		}
		if cgroupNames(string(data), id) {
			pids = append(pids, pid)
		}
	}
	if len(pids) == 0 {
		return 0, fmt.Errorf("no process found for container %s: is the agent running with hostPID and enough privilege to read /proc?", short(id))
	}
	sort.Ints(pids)
	return pids[0], nil
}

// cgroupNames reports whether a /proc/<pid>/cgroup body names this container.
//
// The ID is matched as a whole token rather than as a bare substring, so a
// prefix of one container's ID cannot match another's: runtimes surround it
// with "-", "." or "/" in every layout in use ("cri-containerd-<id>.scope",
// "crio-<id>.scope", "docker-<id>.scope", ".../<id>").
func cgroupNames(body, id string) bool {
	for _, line := range strings.Split(body, "\n") {
		// Each line is "hierarchy:controllers:path"; only the path matters.
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 {
			continue
		}
		for _, token := range strings.FieldsFunc(parts[2], func(c rune) bool {
			return c == '/' || c == '-' || c == '.' || c == '_'
		}) {
			if token == id {
				return true
			}
		}
	}
	return false
}

func short(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

// ContainerRoot is the path whose resolution the kernel performs in the
// container's mount namespace.
func (r *Resolver) ContainerRoot(pid int) string {
	return filepath.Join(r.procRoot, strconv.Itoa(pid), "root")
}

// Verify reports whether a PID still belongs to a container, which is how the
// pool closes the window between resolving a PID and pinning it with a
// watcher: a process that exited in between could have had its number reused.
func (r *Resolver) Verify(pid int, containerID string) bool {
	id, err := NormalizeContainerID(containerID)
	if err != nil {
		return false
	}
	return r.pidMatches(pid, id)
}
