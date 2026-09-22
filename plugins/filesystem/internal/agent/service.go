// Package agent is the DaemonSet half of this plugin: one pod per node,
// hostPID, privileged.
//
// It touches no container filesystem itself. For each request it finds (or
// spawns) a helper process sitting in the target container's mount namespace,
// forwards the identical RPC to it over a socketpair, and returns the answer
// -- adding the two things the helper deliberately does not do: compressing a
// folder download, and translating uids for a pod that runs in its own user
// namespace.
//
// It trusts its caller completely: every request reaching it has already been
// authorized by the plugin backend, which is why the agent must not be
// reachable from anywhere else (see Serve's shared-token check and the
// chart's NetworkPolicy).
package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"runtime"
	"time"

	"connectrpc.com/connect"

	filesystemv1 "console-filesystem-plugin/gen/filesystem/v1"
	"console-filesystem-plugin/gen/filesystem/v1/filesystemv1connect"
	"console-filesystem-plugin/internal/wire"
)

// Config is the agent's operational envelope. Every limit exists because the
// other end of each of these calls is a browser: a listing, a read or an
// archive that is allowed to be unbounded is one a single click can turn into
// an out-of-memory on the node.
type Config struct {
	// ProcRoot is "/proc"; overridden only by tests.
	ProcRoot string
	// PIDCacheTTL bounds how long a container's resolved PID is reused.
	PIDCacheTTL time.Duration
	// HelperGrace is how long a helper outlives its last call.
	HelperGrace time.Duration
	// MaxHelpers caps how many containers this node browses at once. Each
	// helper is a Go runtime at a few MiB, and one user with many tabs open
	// should not be able to spawn them without bound.
	MaxHelpers int

	// CompressionLevel is the 0-9 default applied when a request does not
	// name one, from --archive-compression-level / ARCHIVE_COMPRESSION_LEVEL.
	CompressionLevel int

	MaxListEntries    int
	MaxReadBytes      int64
	MaxArchiveBytes   int64
	MaxArchiveEntries int
	MaxExtractBytes   int64
	MaxExtractEntries int
	MaxUploadChunk    int
	// ChunkSize is how much of a file or archive rides in one stream message.
	ChunkSize int
}

// DefaultConfig is sized for a browser on the other end: big enough that
// ordinary use never meets a limit, small enough that no single request can
// exhaust a node.
func DefaultConfig() Config {
	return Config{
		ProcRoot:       "/proc",
		PIDCacheTTL:    30 * time.Second,
		HelperGrace:    15 * time.Second,
		MaxHelpers:     64,
		MaxListEntries: 5000,
		MaxReadBytes:   256 << 20,
		// Deliberately smaller than the extract budget: a folder download is
		// assembled in the browser's memory as a Blob before it is saved,
		// while an extraction only ever touches the node's disk.
		MaxArchiveBytes:   2 << 30,
		MaxArchiveEntries: 200000,
		MaxExtractBytes:   8 << 30,
		MaxExtractEntries: 200000,
		MaxUploadChunk:    16 << 20,
		ChunkSize:         256 << 10,
		CompressionLevel:  0,
	}
}

// Service implements FileBrowser by delegating to a helper.
type Service struct {
	cfg  Config
	pool *Pool
}

func NewService(cfg Config) (*Service, error) {
	if !Supported {
		return nil, fmt.Errorf("the filesystem agent needs Linux (this binary was built for %s/%s); the plugin backend runs anywhere",
			runtime.GOOS, runtime.GOARCH)
	}
	pool, err := NewPool(cfg)
	if err != nil {
		return nil, err
	}
	return &Service{cfg: cfg, pool: pool}, nil
}

// NewServiceWithPool is for tests, which supply a pool over a fake /proc.
func NewServiceWithPool(cfg Config, pool *Pool) *Service {
	return &Service{cfg: cfg, pool: pool}
}

func (s *Service) Close() {
	if s.pool != nil {
		s.pool.Close()
	}
}

// helperFor resolves the container named by the request's headers and hands
// back its helper. Callers must call the returned release.
func (s *Service) helperFor(header interface{ Get(string) string }) (*Helper, func(), error) {
	containerID := header.Get(wire.HeaderContainerID)
	if containerID == "" {
		return nil, func() {}, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("%s is missing: this agent is only callable through the filesystem plugin backend", wire.HeaderContainerID))
	}
	helper, err := s.pool.Acquire(containerID)
	if err != nil {
		return nil, func() {}, connect.NewError(connect.CodeNotFound, err)
	}
	return helper, func() { s.pool.Release(helper) }, nil
}

// forward copies a request onward to a helper. Nothing is added: the helper
// serves one container for its whole life, so it needs no routing headers.
func forward[Req any](req *connect.Request[Req]) *connect.Request[Req] {
	return connect.NewRequest(req.Msg)
}

func (s *Service) ListDirectory(ctx context.Context, req *connect.Request[filesystemv1.ListDirectoryRequest]) (*connect.Response[filesystemv1.ListDirectoryResponse], error) {
	helper, release, err := s.helperFor(req.Header())
	if err != nil {
		return nil, err
	}
	defer release()

	resp, err := helper.Client().ListDirectory(ctx, forward(req))
	if err != nil {
		return nil, err
	}
	for _, entry := range resp.Msg.GetEntries() {
		translateEntry(helper, entry)
	}
	return connect.NewResponse(resp.Msg), nil
}

func (s *Service) Stat(ctx context.Context, req *connect.Request[filesystemv1.StatRequest]) (*connect.Response[filesystemv1.StatResponse], error) {
	helper, release, err := s.helperFor(req.Header())
	if err != nil {
		return nil, err
	}
	defer release()

	resp, err := helper.Client().Stat(ctx, forward(req))
	if err != nil {
		return nil, err
	}
	translateEntry(helper, resp.Msg.GetEntry())
	return connect.NewResponse(resp.Msg), nil
}

// translateEntry rewrites the node's uid and gid into the container's, which
// is a no-op unless the pod runs in its own user namespace.
func translateEntry(helper *Helper, entry *filesystemv1.Entry) {
	if entry == nil {
		return
	}
	entry.Uid = helper.UIDMap.ToContainer(entry.GetUid())
	entry.Gid = helper.GIDMap.ToContainer(entry.GetGid())
}

func (s *Service) Upload(ctx context.Context, req *connect.Request[filesystemv1.UploadRequest]) (*connect.Response[filesystemv1.UploadResponse], error) {
	helper, release, err := s.helperFor(req.Header())
	if err != nil {
		return nil, err
	}
	defer release()

	if len(req.Msg.GetData()) > s.cfg.MaxUploadChunk {
		return nil, connect.NewError(connect.CodeResourceExhausted,
			fmt.Errorf("upload chunk of %d bytes exceeds the agent's limit of %d", len(req.Msg.GetData()), s.cfg.MaxUploadChunk))
	}
	return helper.Client().Upload(ctx, forward(req))
}

func (s *Service) Extract(ctx context.Context, req *connect.Request[filesystemv1.ExtractRequest]) (*connect.Response[filesystemv1.ExtractResponse], error) {
	helper, release, err := s.helperFor(req.Header())
	if err != nil {
		return nil, err
	}
	defer release()
	return helper.Client().Extract(ctx, forward(req))
}

func (s *Service) Move(ctx context.Context, req *connect.Request[filesystemv1.MoveRequest]) (*connect.Response[filesystemv1.MoveResponse], error) {
	helper, release, err := s.helperFor(req.Header())
	if err != nil {
		return nil, err
	}
	defer release()
	return helper.Client().Move(ctx, forward(req))
}

func (s *Service) Delete(ctx context.Context, req *connect.Request[filesystemv1.DeleteRequest]) (*connect.Response[filesystemv1.DeleteResponse], error) {
	helper, release, err := s.helperFor(req.Header())
	if err != nil {
		return nil, err
	}
	defer release()
	return helper.Client().Delete(ctx, forward(req))
}

func (s *Service) CreateDirectory(ctx context.Context, req *connect.Request[filesystemv1.CreateDirectoryRequest]) (*connect.Response[filesystemv1.CreateDirectoryResponse], error) {
	helper, release, err := s.helperFor(req.Header())
	if err != nil {
		return nil, err
	}
	defer release()
	return helper.Client().CreateDirectory(ctx, forward(req))
}

func (s *Service) ReadFile(ctx context.Context, req *connect.Request[filesystemv1.ReadFileRequest], stream *connect.ServerStream[filesystemv1.ReadFileResponse]) error {
	helper, release, err := s.helperFor(req.Header())
	if err != nil {
		return err
	}
	defer release()

	upstream, err := helper.Client().ReadFile(ctx, forward(req))
	if err != nil {
		return err
	}
	defer upstream.Close()

	for upstream.Receive() {
		if err := stream.Send(upstream.Msg()); err != nil {
			return err
		}
	}
	if err := upstream.Err(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

// Archive asks the helper for an uncompressed tar and compresses it here.
func (s *Service) Archive(ctx context.Context, req *connect.Request[filesystemv1.ArchiveRequest], stream *connect.ServerStream[filesystemv1.ArchiveResponse]) error {
	helper, release, err := s.helperFor(req.Header())
	if err != nil {
		return err
	}
	defer release()

	format := req.Msg.GetFormat()
	if format == filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_UNSPECIFIED {
		format = filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR_GZ
	}
	level := int(req.Msg.GetCompressionLevel())
	if level <= 0 {
		level = s.cfg.CompressionLevel
	}

	tarRequest := connect.NewRequest(&filesystemv1.ArchiveRequest{
		Target: req.Msg.GetTarget(),
		Path:   req.Msg.GetPath(),
		Format: filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR,
	})
	upstream, err := helper.Client().Archive(ctx, tarRequest)
	if err != nil {
		return err
	}
	defer upstream.Close()

	// The helper's tar goes through the compressor and out to the browser
	// without either side ever being buffered whole.
	reader, writer := io.Pipe()
	go func() {
		err := compressStream(writer, &archiveStreamReader{stream: upstream}, format, level)
		_ = writer.CloseWithError(err)
	}()
	defer reader.Close()

	buf := make([]byte, s.cfg.ChunkSize)
	filename := ArchiveFilename(req.Msg.GetPath(), format)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, readErr := reader.Read(buf)
		if n > 0 {
			msg := &filesystemv1.ArchiveResponse{Data: buf[:n]}
			if filename != "" {
				msg.Filename, filename = filename, ""
			}
			if err := stream.Send(msg); err != nil {
				return err
			}
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

// archiveStreamReader turns the helper's message stream back into the byte
// stream the compressor wants.
type archiveStreamReader struct {
	stream *connect.ServerStreamForClient[filesystemv1.ArchiveResponse]
	rest   []byte
}

func (r *archiveStreamReader) Read(p []byte) (int, error) {
	for len(r.rest) == 0 {
		if !r.stream.Receive() {
			if err := r.stream.Err(); err != nil {
				return 0, err
			}
			return 0, io.EOF
		}
		r.rest = r.stream.Msg().GetData()
	}
	n := copy(p, r.rest)
	r.rest = r.rest[n:]
	return n, nil
}

var _ filesystemv1connect.FileBrowserHandler = (*Service)(nil)
