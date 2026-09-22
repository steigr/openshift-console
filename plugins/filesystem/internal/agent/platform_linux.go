//go:build linux

package agent

// Supported reports whether this build can actually reach into a container.
// Only the Linux build can: everywhere else rootfs falls back to a user-space
// emulation meant for unit tests, and /proc/<pid>/root does not exist at all.
const Supported = true
