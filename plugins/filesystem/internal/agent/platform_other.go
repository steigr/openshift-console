//go:build !linux

package agent

// Supported is false off Linux; Serve refuses to start rather than pretending
// to browse containers that cannot exist here.
const Supported = false
