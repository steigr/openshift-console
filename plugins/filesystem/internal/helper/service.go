package helper

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"strings"

	"connectrpc.com/connect"

	filesystemv1 "console-filesystem-plugin/gen/filesystem/v1"
	"console-filesystem-plugin/internal/rootfs"
)

func (s *Service) ListDirectory(_ context.Context, req *connect.Request[filesystemv1.ListDirectoryRequest]) (*connect.Response[filesystemv1.ListDirectoryResponse], error) {
	entries, truncated, err := s.root.List(req.Msg.GetPath(), s.cfg.MaxListEntries)
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
	path := req.Msg.GetPath()
	st, err := s.root.Lstat(path)
	if err != nil {
		return nil, asConnectError(err)
	}
	entry := rootfs.Dirent{Stat: st}
	if st.IsSymlink() {
		entry.LinkTarget, _ = s.root.Readlink(path)
		if target, err := s.root.Stat(path); err == nil {
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
	if info, err := s.root.Statfs(path); err == nil {
		out.FilesystemType = info.Type
		out.FilesystemFreeBytes = info.FreeBytes
		out.FilesystemTotalBytes = info.TotalBytes
	}
	return connect.NewResponse(out), nil
}

func (s *Service) ReadFile(ctx context.Context, req *connect.Request[filesystemv1.ReadFileRequest], stream *connect.ServerStream[filesystemv1.ReadFileResponse]) error {
	path := req.Msg.GetPath()
	st, err := s.root.Stat(path)
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

	file, err := s.root.Open(path)
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
	msg := req.Msg
	if len(msg.GetData()) > s.cfg.MaxUploadChunk {
		return nil, connect.NewError(connect.CodeResourceExhausted,
			fmt.Errorf("upload chunk of %d bytes exceeds the limit of %d", len(msg.GetData()), s.cfg.MaxUploadChunk))
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
	file, err := s.root.OpenWrite(msg.GetPath(), perm, first)
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
		// into: the helper writes as root, and a file the container's own user
		// cannot touch is rarely what an upload was meant to produce.
		if dir, _, splitErr := rootfs.SplitParent(msg.GetPath()); splitErr == nil {
			if parent, statErr := s.root.Stat("/" + dir); statErr == nil && (parent.UID != 0 || parent.GID != 0) {
				_ = s.root.Chown(msg.GetPath(), parent.UID, parent.GID)
			}
		}
	}
	if msg.GetLast() && msg.GetMode() != 0 {
		_ = s.root.Chmod(msg.GetPath(), perm)
	}

	size := msg.GetOffset() + int64(written)
	if st, err := s.root.Stat(msg.GetPath()); err == nil {
		size = st.Size
	}
	return connect.NewResponse(&filesystemv1.UploadResponse{
		BytesWritten: int64(written),
		Size:         size,
	}), nil
}

// Archive streams the requested path as an *uncompressed* tar.
//
// The format field is honoured only to the extent of rejecting anything else:
// compression is the agent's job (see internal/agent/compress.go), so the one
// thing this must never do is silently hand back a format the agent would
// then compress a second time.
func (s *Service) Archive(ctx context.Context, req *connect.Request[filesystemv1.ArchiveRequest], stream *connect.ServerStream[filesystemv1.ArchiveResponse]) error {
	if format := req.Msg.GetFormat(); format != filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_TAR &&
		format != filesystemv1.ArchiveFormat_ARCHIVE_FORMAT_UNSPECIFIED {
		return connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("the helper only produces uncompressed tar; the agent compresses (asked for %s)", format))
	}

	// Built straight into the stream through a pipe: never staged on the
	// node's disk and never held in memory, so archiving a 40 GiB directory
	// costs one buffer.
	reader, writer := io.Pipe()
	go func() {
		err := WriteTar(writer, s.root, req.Msg.GetPath(), ArchiveOptions{
			MaxBytes:   s.cfg.MaxArchiveBytes,
			MaxEntries: s.cfg.MaxArchiveEntries,
		})
		_ = writer.CloseWithError(err)
	}()
	defer reader.Close()

	buf := make([]byte, s.cfg.ChunkSize)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, readErr := reader.Read(buf)
		if n > 0 {
			if err := stream.Send(&filesystemv1.ArchiveResponse{Data: buf[:n]}); err != nil {
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

// Extract stays here rather than moving to the agent with the compression.
// Its destination is inside the container, so streaming the decompressed tar
// back in would need a second channel for no gain -- and the limits that
// matter against an archive that unpacks to far more than it weighs are
// enforced at the point of write, which is here.
func (s *Service) Extract(_ context.Context, req *connect.Request[filesystemv1.ExtractRequest]) (*connect.Response[filesystemv1.ExtractResponse], error) {
	dest := req.Msg.GetDestination()
	if strings.TrimSpace(dest) == "" {
		dest = DefaultDestination(req.Msg.GetPath())
	}
	count, err := Extract(s.root, req.Msg.GetPath(), dest, req.Msg.GetOverwrite(), ExtractLimits{
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
	if err := s.root.Rename(req.Msg.GetSource(), req.Msg.GetDestination(), req.Msg.GetOverwrite()); err != nil {
		return nil, asConnectError(err)
	}
	return connect.NewResponse(&filesystemv1.MoveResponse{Destination: req.Msg.GetDestination()}), nil
}

func (s *Service) Delete(_ context.Context, req *connect.Request[filesystemv1.DeleteRequest]) (*connect.Response[filesystemv1.DeleteResponse], error) {
	removed, err := remove(s.root, req.Msg.GetPath(), req.Msg.GetRecursive())
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
	perm := fs.FileMode(req.Msg.GetMode()).Perm()
	if perm == 0 {
		perm = 0o755
	}
	if err := s.root.MkdirAll(req.Msg.GetPath(), perm); err != nil {
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
	// ModeCharDevice is always set alongside ModeDevice for a character
	// device, so it must be checked first.
	case st.Mode&fs.ModeCharDevice != 0:
		return filesystemv1.EntryType_ENTRY_TYPE_CHAR_DEVICE
	case st.Mode&fs.ModeDevice != 0:
		return filesystemv1.EntryType_ENTRY_TYPE_BLOCK_DEVICE
	case st.Mode&fs.ModeSocket != 0:
		return filesystemv1.EntryType_ENTRY_TYPE_SOCKET
	case st.Mode&fs.ModeNamedPipe != 0:
		return filesystemv1.EntryType_ENTRY_TYPE_FIFO
	default:
		return filesystemv1.EntryType_ENTRY_TYPE_OTHER
	}
}
