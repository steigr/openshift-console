package agent

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"time"

	"connectrpc.com/connect"
	"golang.org/x/net/http2"

	"console-filesystem-plugin/gen/filesystem/v1/filesystemv1connect"
)

// Helper is one running helper process, sitting in one container's mount
// namespace.
type Helper struct {
	containerID string
	// pid is the container's init as the node numbers it -- what the helper
	// joined, and what the watcher watches.
	pid    int
	cmd    *exec.Cmd
	conn   net.Conn
	client filesystemv1connect.FileBrowserClient

	// UIDMap and GIDMap translate the node's numbering to the container's for
	// a pod in its own user namespace; nil for every other pod.
	UIDMap, GIDMap *IDMap

	stopWatch chan struct{}

	inflight int
	lastUsed time.Time
	dead     bool
}

// Client is the FileBrowser this helper serves over its socketpair.
func (h *Helper) Client() filesystemv1connect.FileBrowserClient { return h.client }

// Pool spawns helpers on demand and keeps each one for a grace period after
// its last call.
//
// The grace period is what makes browsing feel free: a helper costs about
// half a millisecond to spawn, so keeping one is an optimisation rather than
// a necessity, but clicking through a tree would otherwise pay for a respawn
// per directory. Fifteen seconds is long enough that a user working on a pod
// never notices one, and short enough that navigating away leaves nothing
// behind for long.
//
// It is short *because* of what a helper holds. A process inside a
// container's mount namespace keeps that namespace, and every mount in it,
// alive after the container is gone -- which is how a volume fails to detach
// and a pod sticks in Terminating. The grace period bounds that, and the
// per-helper watcher removes it: when the container's init exits, the helper
// is killed at once, grace period or not.
type Pool struct {
	cfg      Config
	resolver *Resolver
	selfExe  string

	// Test seams. A unit test cannot join a mount namespace, so it supplies
	// a PID it already knows is alive and a command that serves the helper's
	// service over a sandbox directory instead.
	resolvePID    func(containerID string) (int, error)
	helperCommand func(pid int) *exec.Cmd

	mu      sync.Mutex
	helpers map[string]*Helper
	stopped bool
	stop    chan struct{}
}

func NewPool(cfg Config) (*Pool, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("finding this binary, which is also the helper: %w", err)
	}
	pool := &Pool{
		cfg:      cfg,
		resolver: NewResolver(cfg.ProcRoot, cfg.PIDCacheTTL),
		selfExe:  exe,
		helpers:  map[string]*Helper{},
		stop:     make(chan struct{}),
	}
	pool.resolvePID = func(containerID string) (int, error) { return pool.resolver.PID(containerID) }
	pool.helperCommand = func(pid int) *exec.Cmd {
		// The helper is this same binary: one image means the two halves
		// cannot disagree about the service they speak, and the agent has
		// nothing to locate on disk.
		return exec.Command(pool.selfExe, pool.helperArgs(pid)...)
	}
	go pool.reap()
	return pool, nil
}

// Acquire returns a helper for a container, spawning one if there is none.
// The caller must Release it.
func (p *Pool) Acquire(containerID string) (*Helper, error) {
	id, err := NormalizeContainerID(containerID)
	if err != nil {
		return nil, err
	}

	p.mu.Lock()
	if p.stopped {
		p.mu.Unlock()
		return nil, fmt.Errorf("the agent is shutting down")
	}
	if existing, ok := p.helpers[id]; ok && !existing.dead {
		existing.inflight++
		existing.lastUsed = time.Now()
		p.mu.Unlock()
		return existing, nil
	}
	live := len(p.helpers)
	p.mu.Unlock()

	if p.cfg.MaxHelpers > 0 && live >= p.cfg.MaxHelpers {
		return nil, fmt.Errorf("this node already has %d file browser helpers open; close a Files tab and retry", live)
	}

	helper, err := p.spawn(id)
	if err != nil {
		return nil, err
	}

	p.mu.Lock()
	// Another request may have raced us to the same container; keep whichever
	// landed first and discard ours rather than running two.
	if existing, ok := p.helpers[id]; ok && !existing.dead {
		p.mu.Unlock()
		p.kill(helper)
		p.mu.Lock()
		existing.inflight++
		existing.lastUsed = time.Now()
		p.mu.Unlock()
		return existing, nil
	}
	helper.inflight = 1
	helper.lastUsed = time.Now()
	p.helpers[id] = helper
	p.mu.Unlock()
	return helper, nil
}

// Release marks a call finished. The helper stays until the grace period
// expires with nothing in flight.
func (p *Pool) Release(h *Helper) {
	if h == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if h.inflight > 0 {
		h.inflight--
	}
	h.lastUsed = time.Now()
}

func (p *Pool) spawn(id string) (*Helper, error) {
	pid, err := p.resolvePID(id)
	if err != nil {
		return nil, err
	}

	stopWatch := make(chan struct{})
	gone, err := watchProcess(pid, stopWatch)
	if err != nil {
		return nil, fmt.Errorf("watching container %s: %w", short(id), err)
	}

	// Between resolving the PID and pinning it with the watcher, the process
	// could have exited and its number been reused. Re-checking the cgroup
	// closes that window: if it still names this container, the pid the
	// watcher holds is the right task.
	if p.verifiesPIDs() && !p.resolver.Verify(pid, id) {
		close(stopWatch)
		return nil, fmt.Errorf("container %s exited while it was being opened", short(id))
	}

	parentFile, childFile, err := socketPair()
	if err != nil {
		close(stopWatch)
		return nil, err
	}
	defer childFile.Close()

	cmd := p.helperCommand(pid)
	cmd.ExtraFiles = append(cmd.ExtraFiles, childFile)
	// No stdin at all, and the helper's log lines join the agent's, which is
	// the only way its failures are ever seen.
	cmd.Stdin = nil
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		parentFile.Close()
		close(stopWatch)
		return nil, fmt.Errorf("starting the helper for container %s: %w", short(id), err)
	}

	conn, err := net.FileConn(parentFile)
	parentFile.Close()
	if err != nil {
		_ = cmd.Process.Kill()
		close(stopWatch)
		return nil, fmt.Errorf("adopting the helper's socket: %w", err)
	}

	client, err := newHelperClient(conn)
	if err != nil {
		conn.Close()
		_ = cmd.Process.Kill()
		close(stopWatch)
		return nil, err
	}

	uidMap, gidMap := LoadIDMaps(p.cfg.ProcRoot, pid)
	helper := &Helper{
		containerID: id,
		pid:         pid,
		cmd:         cmd,
		conn:        conn,
		client:      client,
		UIDMap:      uidMap,
		GIDMap:      gidMap,
		stopWatch:   stopWatch,
	}

	// The container going away is the one event that must not wait for a
	// grace period.
	go func() {
		<-gone
		log.Printf("container %s exited; dropping its file browser helper", short(id))
		p.drop(helper)
	}()
	go func() {
		err := cmd.Wait()
		p.mu.Lock()
		helper.dead = true
		if p.helpers[id] == helper {
			delete(p.helpers, id)
		}
		p.mu.Unlock()
		if err != nil {
			log.Printf("file browser helper for container %s ended: %v", short(id), err)
		}
	}()

	log.Printf("started a file browser helper for container %s (pid %d, uid map %s)", short(id), pid, uidMap)
	return helper, nil
}

// verifiesPIDs is false only in tests, which hand the pool a PID directly
// rather than resolving one out of a container's cgroup.
func (p *Pool) verifiesPIDs() bool { return p.resolver != nil && p.cfg.ProcRoot != "" }

// helperArgs hands the helper the same limits the agent was rolled out with,
// so the two halves cannot disagree about them.
func (p *Pool) helperArgs(pid int) []string {
	c := p.cfg
	return []string{
		"helper",
		"--target-pid=" + strconv.Itoa(pid),
		"--max-list-entries=" + strconv.Itoa(c.MaxListEntries),
		"--max-read-bytes=" + strconv.FormatInt(c.MaxReadBytes, 10),
		"--max-archive-bytes=" + strconv.FormatInt(c.MaxArchiveBytes, 10),
		"--max-archive-entries=" + strconv.Itoa(c.MaxArchiveEntries),
		"--max-extract-bytes=" + strconv.FormatInt(c.MaxExtractBytes, 10),
		"--max-extract-entries=" + strconv.Itoa(c.MaxExtractEntries),
		"--max-upload-chunk=" + strconv.Itoa(c.MaxUploadChunk),
		"--chunk-size=" + strconv.Itoa(c.ChunkSize),
	}
}

// singleConn is a connect.HTTPClient over one already-established HTTP/2
// connection. Nothing dials: the socket exists before the client does.
type singleConn struct{ cc *http2.ClientConn }

func (s *singleConn) Do(req *http.Request) (*http.Response, error) { return s.cc.RoundTrip(req) }

func newHelperClient(conn net.Conn) (filesystemv1connect.FileBrowserClient, error) {
	cc, err := (&http2.Transport{AllowHTTP: true}).NewClientConn(conn)
	if err != nil {
		return nil, fmt.Errorf("starting HTTP/2 on the helper socket: %w", err)
	}
	// The host in this URL is never resolved -- the connection is already
	// open -- but connect needs a well-formed base to build request URLs on.
	return filesystemv1connect.NewFileBrowserClient(&singleConn{cc}, "http://helper", connect.WithGRPC()), nil
}

// drop kills a helper now, whatever its grace period says.
func (p *Pool) drop(h *Helper) {
	p.mu.Lock()
	if p.helpers[h.containerID] == h {
		delete(p.helpers, h.containerID)
	}
	h.dead = true
	p.mu.Unlock()
	p.kill(h)
}

func (p *Pool) kill(h *Helper) {
	select {
	case <-h.stopWatch:
	default:
		close(h.stopWatch)
	}
	if h.conn != nil {
		_ = h.conn.Close()
	}
	if h.cmd != nil && h.cmd.Process != nil {
		// SIGKILL rather than SIGTERM: a helper holds nothing worth flushing,
		// and the whole point is to stop holding the mount namespace now.
		_ = h.cmd.Process.Kill()
	}
}

func (p *Pool) reap() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-p.stop:
			return
		case now := <-ticker.C:
			var expired []*Helper
			p.mu.Lock()
			for id, helper := range p.helpers {
				if helper.inflight == 0 && now.Sub(helper.lastUsed) > p.cfg.HelperGrace {
					delete(p.helpers, id)
					helper.dead = true
					expired = append(expired, helper)
				}
			}
			p.mu.Unlock()
			for _, helper := range expired {
				log.Printf("file browser helper for container %s idle for %s; stopping it",
					short(helper.containerID), p.cfg.HelperGrace)
				p.kill(helper)
			}
		}
	}
}

// Close stops every helper. Nothing may hold a mount namespace past the
// agent's own life.
func (p *Pool) Close() {
	p.mu.Lock()
	if p.stopped {
		p.mu.Unlock()
		return
	}
	p.stopped = true
	close(p.stop)
	helpers := make([]*Helper, 0, len(p.helpers))
	for id, helper := range p.helpers {
		helpers = append(helpers, helper)
		delete(p.helpers, id)
	}
	p.mu.Unlock()
	for _, helper := range helpers {
		p.kill(helper)
	}
}
