package helper

import (
	"fmt"
	"net"
	"net/http"
	"os"

	"connectrpc.com/connect"
	"golang.org/x/net/http2"

	"console-filesystem-plugin/gen/filesystem/v1/filesystemv1connect"
)

// ControlFD is where the agent puts its end of the socketpair in the helper's
// file descriptor table: 0, 1 and 2 stay stdin/stdout/stderr (stderr is how
// the helper's log lines reach the agent's), so the first extra file lands on
// 3.
const ControlFD = 3

// Serve answers FileBrowser calls on an already-connected socket until the
// agent closes it or the process is killed.
//
// It is a socketpair rather than the pipe pair "gRPC over stdin/stdout"
// suggests, for three reasons: it is bidirectional, so one descriptor carries
// both directions; net.FileConn turns it into a real net.Conn, so the
// *existing* h2c server works on it unchanged; and HTTP/2 multiplexes, so
// concurrent RPCs to one helper share the single connection instead of
// needing a framing protocol of their own.
//
// Nothing here listens. The helper has no address, cannot be reached by
// anything that was not handed this descriptor, and therefore needs no
// authentication of its own -- the agent's shared token guards the only door
// into this whole path.
func Serve(cfg Config, conn net.Conn) error {
	return ServeWithService(NewService(cfg), conn)
}

// ControlConn adopts the descriptor the agent passed. The *os.File is closed
// once the connection owns the descriptor, as net.FileConn dups it.
func ControlConn() (net.Conn, error) {
	file := os.NewFile(uintptr(ControlFD), "control")
	if file == nil {
		return nil, fmt.Errorf("no control socket on fd %d: the helper is spawned by the agent, not run by hand", ControlFD)
	}
	conn, err := net.FileConn(file)
	closeErr := file.Close()
	if err != nil {
		return nil, fmt.Errorf("adopting the control socket: %w", err)
	}
	if closeErr != nil {
		return nil, fmt.Errorf("closing the duplicated control descriptor: %w", closeErr)
	}
	return conn, nil
}

// ServeWithService is Serve with the service supplied rather than built, which
// is how the agent's own tests stand in for a helper without joining a
// namespace.
func ServeWithService(svc *Service, conn net.Conn) error {
	path, handler := filesystemv1connect.NewFileBrowserHandler(
		svc,
		connect.WithReadMaxBytes(svc.cfg.MaxUploadChunk+(1<<20)),
	)
	mux := http.NewServeMux()
	mux.Handle(path, handler)
	(&http2.Server{}).ServeConn(conn, &http2.ServeConnOpts{Handler: mux})
	return nil
}
