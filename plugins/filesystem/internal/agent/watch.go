package agent

import (
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// procWatchInterval is how often the fallback watcher asks whether a process
// is still there. It only runs on kernels without pidfd_open (pre-5.3), where
// a second of latency before a helper notices its container died is still far
// better than the minutes an idle timer would take.
const procWatchInterval = time.Second

// watchProcessByProc is the pidfd fallback: poll for the /proc entry going
// away. It is racy against PID reuse in a way a pidfd is not, which is why it
// is the fallback and not the implementation.
func watchProcessByProc(pid int, stop <-chan struct{}) <-chan struct{} {
	gone := make(chan struct{})
	path := filepath.Join(procRootForWatch, strconv.Itoa(pid))
	go func() {
		defer close(gone)
		ticker := time.NewTicker(procWatchInterval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				if _, err := os.Stat(path); err != nil {
					return
				}
			}
		}
	}()
	return gone
}

// procRootForWatch is "/proc" outside tests; it is a package-level var so the
// pool's tests can point the fallback watcher at a fake tree.
var procRootForWatch = "/proc"
