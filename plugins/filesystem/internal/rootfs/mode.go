package rootfs

import "io/fs"

// rawSpecialBits maps Go's portable setuid/setgid/sticky flags back onto the
// st_mode bits `ls -l` renders and `chmod` takes.
func rawSpecialBits(mode fs.FileMode) uint32 {
	var raw uint32
	if mode&fs.ModeSetuid != 0 {
		raw |= 0o4000
	}
	if mode&fs.ModeSetgid != 0 {
		raw |= 0o2000
	}
	if mode&fs.ModeSticky != 0 {
		raw |= 0o1000
	}
	return raw
}
