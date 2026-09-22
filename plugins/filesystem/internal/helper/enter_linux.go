//go:build linux

package helper

import (
	"fmt"
	"os"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// enteredEnv marks the second half of Enter's two-stage start. It is an
// environment variable rather than a flag so that nothing about the helper's
// command line changes between the two stages, which keeps `ps` on a node
// showing the same thing the agent logged.
const enteredEnv = "FILESYSTEM_HELPER_ENTERED"

// Entered reports whether this process is already inside the container.
func Entered() bool { return os.Getenv(enteredEnv) == "1" }

// Enter joins the mount namespace of the process with the given PID -- the
// container's init, as the host numbers it -- and then re-executes this
// binary inside it. It does not return on success.
//
// Three things about this are not obvious, and the third is the one that
// bites.
//
// First, the obvious call fails: setns(CLONE_NEWNS) from a Go program returns
// EINVAL. The usual explanation ("Go is multithreaded") is not quite the
// reason -- the Go runtime creates threads with CLONE_FS, so they share one
// fs_struct, and mntns_install() refuses unless that struct has exactly one
// user. unshare(CLONE_FS) on a thread of our own gives it a private
// fs_struct, after which setns succeeds.
//
// Second, on success the kernel also moves that thread's root and working
// directory to the new namespace's root (mntns_install calls set_fs_root and
// set_fs_pwd). That is the property the whole design rests on: "/" becomes
// the container's root, so ordinary path resolution is correct and contained
// without any help from us.
//
// Third -- and this is why the function ends in an execve rather than a
// return -- all of that applies to *one thread*. A Go HTTP server answers on
// whatever goroutine the scheduler picks, on whatever thread that goroutine
// lands on, and those threads are still in the agent's namespace. Serving
// from here without re-executing produces exactly one symptom: the helper
// starts, reports success, and then answers every request out of the agent's
// own filesystem. execve is the fix, because a process that has entered the
// namespace and then replaces its image starts single-threaded inside it, and
// every thread the new runtime spawns inherits it.
//
// The binary cannot be re-executed by path: after the setns above, this
// process's filesystem is the container's, where the agent's own binary does
// not exist. So /proc/self/exe is opened *before* entering and the exec is an
// execveat(2) of that descriptor, which the kernel honours regardless of what
// the path namespace now looks like. This is why the helper must be a static
// binary -- there is no dynamic loader in the container to find either.
func Enter(pid int) error {
	// Opened before the namespace switch, while this binary is still
	// reachable.
	exeFd, err := unix.Open("/proc/self/exe", unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("opening this binary before entering the container: %w", err)
	}

	runtime.LockOSThread()

	nsFd, err := unix.Open(fmt.Sprintf("/proc/%d/ns/mnt", pid), unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("opening the mount namespace of pid %d: %w", pid, err)
	}
	defer unix.Close(nsFd)

	if err := unix.Unshare(unix.CLONE_FS); err != nil {
		return fmt.Errorf("unsharing this thread's fs_struct: %w", err)
	}
	if err := unix.Setns(nsFd, unix.CLONE_NEWNS); err != nil {
		return fmt.Errorf("joining the mount namespace of pid %d: %w", pid, err)
	}

	env := append(os.Environ(), enteredEnv+"=1")
	if err := execveat(exeFd, os.Args, env); err != nil {
		return fmt.Errorf("re-executing inside the container: %w", err)
	}
	// Unreachable: execveat either replaced this image or returned an error.
	return nil
}

// execveat is execveat(2) with AT_EMPTY_PATH, i.e. "execute this open file",
// which x/sys/unix does not wrap. It is the only way to exec a binary whose
// path no longer resolves -- which is the situation the moment this process
// joins a container that does not contain the agent's image.
func execveat(fd int, argv, env []string) error {
	argvp, err := syscall.SlicePtrFromStrings(argv)
	if err != nil {
		return err
	}
	envp, err := syscall.SlicePtrFromStrings(env)
	if err != nil {
		return err
	}
	empty, err := syscall.BytePtrFromString("")
	if err != nil {
		return err
	}
	_, _, errno := unix.RawSyscall6(
		unix.SYS_EXECVEAT,
		uintptr(fd),
		uintptr(unsafe.Pointer(empty)),
		uintptr(unsafe.Pointer(&argvp[0])),
		uintptr(unsafe.Pointer(&envp[0])),
		uintptr(unix.AT_EMPTY_PATH),
		0,
	)
	if errno != 0 {
		return errno
	}
	return nil
}
