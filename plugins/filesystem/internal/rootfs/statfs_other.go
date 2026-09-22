//go:build !linux

package rootfs

// statfs has no portable equivalent; the fields it fills in the Info dialog
// are simply absent off Linux, which only ever runs the tests.
func statfs(_ string) (*FSInfo, error) {
	return &FSInfo{}, nil
}
