//go:build unix

package agent

import (
	"fmt"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// socketPair returns the two ends of a connected stream socket: one the agent
// keeps, one the helper inherits as fd 3.
//
// SOCK_CLOEXEC is not portable across every unix x/sys builds for, so the
// flag is set afterwards under ForkLock -- which is what keeps a concurrent
// fork from inheriting a descriptor in the window between the two calls, and
// the reason this is not just two lines.
func socketPair() (parent, child *os.File, err error) {
	syscall.ForkLock.RLock()
	fds, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM, 0)
	if err == nil {
		unix.CloseOnExec(fds[0])
		unix.CloseOnExec(fds[1])
	}
	syscall.ForkLock.RUnlock()
	if err != nil {
		return nil, nil, fmt.Errorf("creating the helper control socket: %w", err)
	}
	return os.NewFile(uintptr(fds[0]), "helper-control-parent"),
		os.NewFile(uintptr(fds[1]), "helper-control-child"),
		nil
}
