//go:build !linux

package helper

import (
	"fmt"
	"runtime"
)

// Entered is false off Linux; Enter never succeeds there.
func Entered() bool { return false }

// Enter has no meaning off Linux; the agent refuses to spawn a helper there,
// and this exists so the rest of the package still builds for the tests.
func Enter(int) error {
	return fmt.Errorf("joining a mount namespace needs Linux (this binary was built for %s/%s)",
		runtime.GOOS, runtime.GOARCH)
}
