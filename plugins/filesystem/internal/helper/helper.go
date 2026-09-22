// Package helper is the half of this plugin that runs *inside* a container's
// mount namespace.
//
// One helper process serves one container. The agent spawns it, it joins the
// container's mount namespace before doing anything else (see Enter), and
// from then on its "/" is the container's root -- so every path operation is
// an ordinary os call, correct and contained because the kernel says so
// rather than because this code checked.
//
// It speaks the same FileBrowser service as everything else, over a
// socketpair the agent handed it as a file descriptor. Nothing about that
// hop touches the network: the agent does not have to reach it, find it or
// authorize it, and the helper has no listening socket to be reached on.
//
// What it deliberately does not do is compress. Folder downloads leave here
// as an uncompressed tar stream and the agent applies gzip, zstd or a zip
// transcode outside the namespace. That keeps the namespace-joined process to
// syscalls and tar framing: the codec work, which is where a pathological
// input costs CPU and memory, runs in the agent's ordinary context, and the
// helper stays something that can be killed at any instant without losing
// anything.
package helper

import (
	"errors"
	"os"
	"time"

	"connectrpc.com/connect"

	"console-filesystem-plugin/internal/rootfs"
)

// Config is the helper's operational envelope, handed down from the agent's
// own flags so both halves agree on the limits.
type Config struct {
	MaxListEntries    int
	MaxReadBytes      int64
	MaxExtractBytes   int64
	MaxExtractEntries int
	MaxArchiveBytes   int64
	MaxArchiveEntries int
	MaxUploadChunk    int
	// ChunkSize is how much of a file or archive rides in one stream message.
	ChunkSize int
}

func DefaultConfig() Config {
	return Config{
		MaxListEntries:    5000,
		MaxReadBytes:      256 << 20,
		MaxExtractBytes:   8 << 30,
		MaxExtractEntries: 200000,
		MaxArchiveBytes:   2 << 30,
		MaxArchiveEntries: 200000,
		MaxUploadChunk:    16 << 20,
		ChunkSize:         256 << 10,
	}
}

// Service implements FileBrowser against the root this process is sitting in.
type Service struct {
	cfg  Config
	root *rootfs.Root
}

// NewService serves this process's own root, which after Enter is the
// container's.
func NewService(cfg Config) *Service {
	if cfg.ChunkSize <= 0 {
		cfg.ChunkSize = DefaultConfig().ChunkSize
	}
	return &Service{cfg: cfg, root: rootfs.Native()}
}

// NewServiceWithRoot serves an arbitrary root; the tests use it with a
// sandbox directory instead of a namespace.
func NewServiceWithRoot(cfg Config, root *rootfs.Root) *Service {
	if cfg.ChunkSize <= 0 {
		cfg.ChunkSize = DefaultConfig().ChunkSize
	}
	return &Service{cfg: cfg, root: root}
}

// asConnectError maps the filesystem's own errors onto codes the browser can
// act on, so the frontend can say "no such file" or "permission denied"
// rather than "internal error".
func asConnectError(err error) error {
	if err == nil {
		return nil
	}
	var alreadyCoded *connect.Error
	if errors.As(err, &alreadyCoded) {
		return err
	}
	switch {
	case errors.Is(err, rootfs.ErrEscape):
		return connect.NewError(connect.CodePermissionDenied, err)
	case errors.Is(err, rootfs.ErrCrossDevice):
		return connect.NewError(connect.CodeFailedPrecondition, err)
	case errors.Is(err, os.ErrNotExist):
		return connect.NewError(connect.CodeNotFound, err)
	case errors.Is(err, os.ErrExist):
		return connect.NewError(connect.CodeAlreadyExists, err)
	case errors.Is(err, os.ErrPermission):
		return connect.NewError(connect.CodePermissionDenied, err)
	case errors.Is(err, os.ErrInvalid):
		return connect.NewError(connect.CodeInvalidArgument, err)
	case errors.Is(err, ErrArchiveTooLarge), errors.Is(err, ErrArchiveTooBig):
		return connect.NewError(connect.CodeResourceExhausted, err)
	case errors.Is(err, ErrUnknownArchive):
		return connect.NewError(connect.CodeInvalidArgument, err)
	default:
		return connect.NewError(connect.CodeInternal, err)
	}
}

// IdleGrace is how long the agent keeps a helper after the last call. See
// internal/agent's pool: it is short enough that a user who navigates away
// leaves nothing behind for long, and long enough that clicking around a tree
// never pays for a respawn.
const IdleGrace = 15 * time.Second
