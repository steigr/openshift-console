// Package agent is the half of this plugin that runs on every node, as a
// DaemonSet with hostPID, and is the only half that touches a container's
// filesystem. It trusts its caller completely: every request reaching it has
// already been authorized by the plugin backend, which is why the agent must
// not be reachable from anywhere else (see Serve's shared-token check and the
// chart's NetworkPolicy).
package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"
	"time"

	"connectrpc.com/connect"

	filesystemv1 "console-filesystem-plugin/gen/filesystem/v1"
	"console-filesystem-plugin/internal/rootfs"
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

	MaxListEntries    int
	MaxReadBytes      int64
	MaxArchiveBytes   int64
	MaxArchiveEntries int
	MaxExtractBytes   int64
	MaxExtractEntries int
	MaxUploadChunk    int
	// ChunkSize is how much of a file or archive rides in one stream message.
	ChunkSize int
	// CompressionLevel is the 0-9 default applied when a request does not
	// name one, from --archive-compression-level / ARCHIVE_COMPRESSION_LEVEL.
	CompressionLevel int
}

// DefaultConfig is sized for a browser on the other end: big enough that
// ordinary use never meets a limit, small enough that no single request can
// exhaust a node.
func DefaultConfig() Config {
	return Config{
		ProcRoot:       "/proc",
		PIDCacheTTL:    30 * time.Second,
		MaxListEntries: 5000,
		MaxReadBytes:   256 << 20,
		// Deliberately smaller than the extract budget below: a folder
		// download is assembled in the browser's memory as a Blob before it
		// is saved, while an extraction only ever touches the node's disk.
		MaxArchiveBytes:   2 << 30,
		MaxArchiveEntries: 200000,
		MaxExtractBytes:   8 << 30,
		MaxExtractEntries: 200000,
		MaxUploadChunk:    16 << 20,
		ChunkSize:         256 << 10,
		CompressionLevel:  0,
	}
}

// Service implements the FileBrowser service against real containers.
type Service struct {
	cfg      Config
	resolver *Resolver
}

func NewService(cfg Config) *Service {
	if cfg.ChunkSize <= 0 {
		cfg.ChunkSize = DefaultConfig().ChunkSize
	}
	return &Service{cfg: cfg, resolver: NewResolver(cfg.ProcRoot, cfg.PIDCacheTTL)}
}

// open resolves the container named by the request's headers and returns a
// handle on its filesystem. Callers close it.
func (s *Service) open(header interface{ Get(string) string }) (*rootfs.Root, error) {
	containerID := header.Get(wire.HeaderContainerID)
	if containerID == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("%s is missing: this agent is only callable through the filesystem plugin backend", wire.HeaderContainerID))
	}
	pid, err := s.resolver.PID(containerID)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	root, err := rootfs.Open(s.resolver.ContainerRoot(pid))
	if err != nil {
		if errors.Is(err, rootfs.ErrUnsupported) {
			return nil, connect.NewError(connect.CodeFailedPrecondition, err)
		}
		return nil, connect.NewError(connect.CodeNotFound,
			fmt.Errorf("opening the filesystem of container %s (pid %d): %w", short(containerID), pid, err))
	}
	return root, nil
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
	case errors.Is(err, rootfs.ErrUnsupported):
		return connect.NewError(connect.CodeFailedPrecondition, err)
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

func (s *Service) ListDirectory(_ context.Context, req *connect.Request[filesystemv1.ListDirectoryRequest]) (*connect.Response[filesystemv1.ListDirectoryResponse], error) {
	root, err := s.open(req.Header())
	if err != nil {
		return nil, err
	}
	defer root.Close()

	entries, truncated, err := root.List(req.Msg.GetPath(), s.cfg.MaxListEntries)
	if err != nil {
		return nil, asConnectError(err)
	}
	out := &filesystemv1.ListDirectoryResponse{
		Entries:   make([]*filesystemv1.Entry, 0, len(entries)),
		Truncated: truncated,
	}
	for i := range entries {
		out.Entries = append(out.Entries, toProtoEntry(&entries[i]))
	}
	return connect.NewResponse(out), nil
}

func (s *Service) Stat(_ context.Context, req *connect.Request[filesystemv1.StatRequest]) (*connect.Response[filesystemv1.StatResponse], error) {
	root, err := s.open(req.Header())
	if err != nil {
		return nil, err
	}
	defer root.Close()

	st, err := root.Lstat(req.Msg.GetPath())
	if err != nil {
		return nil, asConnectError(err)
	}
	entry := rootfs.Dirent{Stat: st}
	if st.IsSymlink() {
		entry.LinkTarget, _ = root.Readlink(req.Msg.GetPath())
		if target, err := root.Stat(req.Msg.GetPath()); err == nil {
			entry.TargetIsDir = target.IsDir()
		}
	}
	out := &filesystemv1.StatResponse{
		Entry:        toProtoEntry(&entry),
		AccessedUnix: st.AccessTime.Unix(),
		ChangedUnix:  st.ChangeTime.Unix(),
		HardLinks:    st.HardLinks,
		Device:       st.Device,
		Inode:        st.Inode,
	}
	// Filesystem figures are a nicety, and statfs can fail on an entry whose
	// mount has gone away; the rest of the answer is still worth returning.
	if info, err := root.Statfs(req.Msg.GetPath()); err == nil {
		out.FilesystemType = info.Type
		out.FilesystemFreeBytes = info.FreeBytes
		out.FilesystemTotalBytes = info.TotalBytes
	}
	return connect.NewResponse(out), nil
}

func (s *Service) ReadFile(ctx context.Context, req *connect.Request[filesystemv1.ReadFileRequest], stream *connect.ServerStream[filesystemv1.ReadFileResponse]) error {
	root, err := s.open(req.Header())
	if err != nil {
		return err
	}
	defer root.Close()

	path := req.Msg.GetPath()
	st, err := root.Stat(path)
	if err != nil {
		return asConnectError(err)
	}
	if !st.IsRegular() {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("%s is not a regular file", path))
	}

	limit := s.cfg.MaxReadBytes
	if requested := req.Msg.GetMaxBytes(); requested > 0 && (limit <= 0 || requested < limit) {
		limit = requested
	}
	if limit > 0 && st.Size > limit && req.Msg.GetMaxBytes() == 0 {
		return connect.NewError(connect.CodeResourceExhausted,
			fmt.Errorf("%s is %d bytes, more than this agent will serve in one read (%d)", path, st.Size, limit))
	}

	file, err := root.Open(path)
	if err != nil {
		return asConnectError(err)
	}
	defer file.Close()

	var src io.Reader = file
	if limit > 0 {
		src = io.LimitReader(file, limit)
	}
	buf := make([]byte, s.cfg.ChunkSize)
	first := true
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, readErr := src.Read(buf)
		if n > 0 {
			msg := &filesystemv1.ReadFileResponse{Data: buf[:n]}
			if first {
				msg.TotalSize, first = st.Size, false
			}
			if err := stream.Send(msg); err != nil {
				return err
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return asConnectError(readErr)
		}
	}
	if first {
		// An empty file still owes the caller its size.
		return stream.Send(&filesystemv1.ReadFileResponse{TotalSize: st.Size})
	}
	return nil
}

func (s *Service) Upload(_ context.Context, req *connect.Request[filesystemv1.UploadRequest]) (*connect.Response[filesystemv1.UploadResponse], error) {
	root, err := s.open(req.Header())
	if err != nil {
		return nil, err
	}
	defer root.Close()

	msg := req.Msg
	if len(msg.GetData()) > s.cfg.MaxUploadChunk {
		return nil, connect.NewError(connect.CodeResourceExhausted,
			fmt.Errorf("upload chunk of %d bytes exceeds the agent's limit of %d", len(msg.GetData()), s.cfg.MaxUploadChunk))
	}
	if msg.GetOffset() < 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("upload offset must not be negative"))
	}

	perm := fs.FileMode(msg.GetMode()).Perm()
	if perm == 0 {
		perm = 0o644
	}
	// Offset 0 truncates, which is what makes a restarted upload replace the
	// file instead of leaving an older, longer file's tail behind it.
	first := msg.GetOffset() == 0
	file, err := root.OpenWrite(msg.GetPath(), perm, first)
	if err != nil {
		return nil, asConnectError(err)
	}
	defer file.Close()

	written, err := file.WriteAt(msg.GetData(), msg.GetOffset())
	if err != nil {
		return nil, asConnectError(err)
	}
	if first {
		// Land the file with the same ownership as the directory it goes
		// into: the agent writes as root, and a file the container's own user
		// cannot touch is rarely what an upload was meant to produce.
		if dir, _, splitErr := rootfs.SplitParent(msg.GetPath()); splitErr == nil {
			if parent, statErr := root.Stat("/" + dir); statErr == nil && (parent.UID != 0 || parent.GID != 0) {
				_ = root.Chown(msg.GetPath(), parent.UID, parent.GID)
			}
		}
	}
	if msg.GetLast() && msg.GetMode() != 0 {
		_ = root.Chmod(msg.GetPath(), perm)
	}

	size := msg.GetOffset() + int64(written)
	if st, err := root.Stat(msg.GetPath()); err == nil {
		size = st.Size
	}
	return connect.NewResponse(&filesystemv1.UploadResponse{
		BytesWritten: int64(written),
		Size:         size,
	}), nil
}

func (s *Service) Archive(ctx context.Context, req *connect.Request[filesystemv1.ArchiveRequest], stream *connect.ServerStream[filesystemv1.ArchiveResponse]) error {
	root, err := s.open(req.Header())
	if err != nil {
		return err
	}
	defer root.Close()

	format := req.Msg.GetFormat()
	if format == filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_UNSPECIFIED {
		format = filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR_GZ
	}
	level := int(req.Msg.GetCompressionLevel())
	if level <= 0 {
		level = s.cfg.CompressionLevel
	}

	// The archive is built straight into the stream through a pipe: it is
	// never staged on the node's disk and never held in the agent's memory,
	// so archiving a 40 GiB directory costs one buffer.
	reader, writer := io.Pipe()
	go func() {
		err := WriteArchive(writer, root, req.Msg.GetPath(), ArchiveOptions{
			Format:     format,
			Level:      level,
			MaxBytes:   s.cfg.MaxArchiveBytes,
			MaxEntries: s.cfg.MaxArchiveEntries,
		})
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
			return asConnectError(readErr)
		}
	}
}

func (s *Service) Extract(_ context.Context, req *connect.Request[filesystemv1.ExtractRequest]) (*connect.Response[filesystemv1.ExtractResponse], error) {
	root, err := s.open(req.Header())
	if err != nil {
		return nil, err
	}
	defer root.Close()

	dest := req.Msg.GetDestination()
	if strings.TrimSpace(dest) == "" {
		dest = DefaultDestination(req.Msg.GetPath())
	}
	count, err := Extract(root, req.Msg.GetPath(), dest, req.Msg.GetOverwrite(), ExtractLimits{
		MaxEntries: s.cfg.MaxExtractEntries,
		MaxBytes:   s.cfg.MaxExtractBytes,
	})
	if err != nil {
		return nil, asConnectError(err)
	}
	return connect.NewResponse(&filesystemv1.ExtractResponse{
		Destination:    dest,
		EntriesWritten: count,
	}), nil
}

func (s *Service) Move(_ context.Context, req *connect.Request[filesystemv1.MoveRequest]) (*connect.Response[filesystemv1.MoveResponse], error) {
	root, err := s.open(req.Header())
	if err != nil {
		return nil, err
	}
	defer root.Close()

	if err := root.Rename(req.Msg.GetSource(), req.Msg.GetDestination(), req.Msg.GetOverwrite()); err != nil {
		return nil, asConnectError(err)
	}
	return connect.NewResponse(&filesystemv1.MoveResponse{Destination: req.Msg.GetDestination()}), nil
}

func (s *Service) Delete(_ context.Context, req *connect.Request[filesystemv1.DeleteRequest]) (*connect.Response[filesystemv1.DeleteResponse], error) {
	root, err := s.open(req.Header())
	if err != nil {
		return nil, err
	}
	defer root.Close()

	removed, err := remove(root, req.Msg.GetPath(), req.Msg.GetRecursive())
	if err != nil {
		return nil, asConnectError(err)
	}
	return connect.NewResponse(&filesystemv1.DeleteResponse{EntriesRemoved: removed}), nil
}

// remove deletes path, descending first when recursive. It never follows a
// symlink to a directory: deleting a link deletes the link.
func remove(root *rootfs.Root, path string, recursive bool) (int64, error) {
	st, err := root.Lstat(path)
	if err != nil {
		return 0, err
	}
	if !st.IsDir() {
		return 1, root.Remove(path)
	}
	if !recursive {
		// An empty directory still goes; a non-empty one comes back as
		// ENOTEMPTY, which is the answer the frontend turns into its "delete
		// everything in here?" confirmation.
		return 1, root.Remove(path)
	}
	var removed int64
	entries, _, err := root.List(path, 0)
	if err != nil {
		return 0, err
	}
	for _, entry := range entries {
		n, err := remove(root, rootfs.Join(path, entry.Stat.Name), true)
		removed += n
		if err != nil {
			return removed, err
		}
	}
	if err := root.Remove(path); err != nil {
		return removed, err
	}
	return removed + 1, nil
}

func (s *Service) CreateDirectory(_ context.Context, req *connect.Request[filesystemv1.CreateDirectoryRequest]) (*connect.Response[filesystemv1.CreateDirectoryResponse], error) {
	root, err := s.open(req.Header())
	if err != nil {
		return nil, err
	}
	defer root.Close()

	perm := fs.FileMode(req.Msg.GetMode()).Perm()
	if perm == 0 {
		perm = 0o755
	}
	if err := root.MkdirAll(req.Msg.GetPath(), perm); err != nil {
		return nil, asConnectError(err)
	}
	return connect.NewResponse(&filesystemv1.CreateDirectoryResponse{Path: req.Msg.GetPath()}), nil
}

func toProtoEntry(entry *rootfs.Dirent) *filesystemv1.Entry {
	st := entry.Stat
	return &filesystemv1.Entry{
		Name:              st.Name,
		Type:              entryType(st),
		Size:              st.Size,
		Mode:              st.RawMode,
		Uid:               st.UID,
		Gid:               st.GID,
		ModifiedUnix:      st.ModTime.Unix(),
		LinkTarget:        entry.LinkTarget,
		TargetIsDirectory: entry.TargetIsDir,
	}
}

func entryType(st *rootfs.Stat) filesystemv1.EntryType {
	switch {
	case st.IsSymlink():
		return filesystemv1.EntryType_ENTRY_TYPE_SYMLINK
	case st.IsDir():
		return filesystemv1.EntryType_ENTRY_TYPE_DIRECTORY
	case st.IsRegular():
		return filesystemv1.EntryType_ENTRY_TYPE_FILE
	default:
		return filesystemv1.EntryType_ENTRY_TYPE_OTHER
	}
}
