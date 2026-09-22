//go:build !linux

package agent

// watchProcess has no pidfd off Linux; the /proc poll is enough for the tests,
// and the agent refuses to serve on such a platform anyway.
func watchProcess(pid int, stop <-chan struct{}) (<-chan struct{}, error) {
	return watchProcessByProc(pid, stop), nil
}
