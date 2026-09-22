//go:build linux

package agent

import (
	"golang.org/x/sys/unix"
)

// watchProcess reports when a process exits.
//
// It uses a pidfd, which binds the *task* rather than the number, so there is
// no window in which PID reuse could make a dead container look alive. That
// matters more here than it usually does: the thing being watched is the
// container whose mount namespace a helper is sitting in, and a helper that
// outlives its container keeps that namespace -- and every mount in it --
// alive on the node, which is how volumes fail to detach and pods get stuck
// Terminating.
//
// The poll has a timeout rather than blocking forever so the watcher can be
// told to stop without an eventfd or a second descriptor.
func watchProcess(pid int, stop <-chan struct{}) (<-chan struct{}, error) {
	fd, err := unix.PidfdOpen(pid, 0)
	if err != nil {
		// Pre-5.3 kernels have no pidfd; fall back to asking /proc.
		return watchProcessByProc(pid, stop), nil
	}

	gone := make(chan struct{})
	go func() {
		defer close(gone)
		defer unix.Close(fd)
		fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
		for {
			select {
			case <-stop:
				return
			default:
			}
			n, err := unix.Poll(fds, 500)
			if err != nil && err != unix.EINTR {
				return
			}
			if n > 0 {
				return
			}
		}
	}()
	return gone, nil
}
