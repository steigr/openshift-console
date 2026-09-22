package api

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"connectrpc.com/connect"
	"golang.org/x/net/http2"

	filesystemv1 "console-filesystem-plugin/gen/filesystem/v1"
	"console-filesystem-plugin/gen/filesystem/v1/filesystemv1connect"
	"console-filesystem-plugin/internal/wire"
)

// targeted is implemented by every request message: each one names the
// container it is about, and that is all this backend reads out of them. The
// bodies -- paths, chunks, archive formats -- are the agent's business and
// travel through untouched.
type targeted interface {
	GetTarget() *filesystemv1.Target
}

// Proxy implements the FileBrowser service by authorizing the caller and
// forwarding the identical call to the agent on the node where the target
// container runs.
type Proxy struct {
	agentPort  string
	agentToken string
	client     *http.Client
}

// NewProxy builds the backend service. The HTTP client speaks h2c: connect-go
// uses the gRPC protocol for this hop, gRPC requires HTTP/2, and the agent
// serves plaintext inside the cluster.
func NewProxy() *Proxy {
	return &Proxy{
		agentPort:  GetEnv("AGENT_PORT", "9090"),
		agentToken: GetEnv("AGENT_TOKEN", ""),
		client: &http.Client{
			Transport: &http2.Transport{
				AllowHTTP: true,
				DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
					return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, addr)
				},
			},
			// No client timeout: an archive of a large directory, or the
			// upload of a large file, legitimately outlasts any number worth
			// picking. The browser's own cancellation propagates through the
			// request context instead.
		},
	}
}

// connectAgent authorizes the caller for the request's target and returns a
// client for the agent that can reach it, plus the headers that tell the
// agent which container the call is about.
func (p *Proxy) connectAgent(ctx context.Context, header http.Header, msg any) (filesystemv1connect.FileBrowserClient, http.Header, error) {
	withTarget, ok := msg.(targeted)
	if !ok || withTarget.GetTarget() == nil {
		return nil, nil, connect.NewError(connect.CodeInvalidArgument, errors.New("request has no target container"))
	}
	target := withTarget.GetTarget()
	namespace, pod := target.GetNamespace(), target.GetPod()
	if namespace == "" || pod == "" {
		return nil, nil, connect.NewError(connect.CodeInvalidArgument, errors.New("target must name a namespace and a pod"))
	}

	// Authorization first, and before the pod is even read: a user who may
	// not exec into this pod should not learn from the error message whether
	// it exists.
	if err := authorizeContainerAccess(ctx, header, namespace, pod); err != nil {
		return nil, nil, toConnectError(err)
	}

	resolved, err := resolvePod(ctx, header, namespace, pod, target.GetContainer())
	if err != nil {
		return nil, nil, toConnectError(err)
	}

	agentIP, err := lookupAgent(ctx, resolved.Node)
	if err != nil {
		return nil, nil, connect.NewError(connect.CodeUnavailable, err)
	}

	out := http.Header{}
	out.Set(wire.HeaderContainerID, resolved.ContainerID)
	if p.agentToken != "" {
		out.Set("Authorization", "Bearer "+p.agentToken)
	}

	base := "http://" + net.JoinHostPort(agentIP, p.agentPort)
	return filesystemv1connect.NewFileBrowserClient(p.client, base, connect.WithGRPC()), out, nil
}

// toConnectError turns the API server's own verdicts into codes the frontend
// can distinguish, so a 403 reads as "you may not exec into this pod" rather
// than as a generic failure.
func toConnectError(err error) error {
	var status *apiStatusError
	if errors.As(err, &status) {
		switch status.Status() {
		case http.StatusUnauthorized:
			return connect.NewError(connect.CodeUnauthenticated, err)
		case http.StatusForbidden:
			return connect.NewError(connect.CodePermissionDenied, err)
		case http.StatusNotFound:
			return connect.NewError(connect.CodeNotFound, err)
		}
	}
	if errors.Is(err, errNoCredentials) {
		return connect.NewError(connect.CodeUnauthenticated, err)
	}
	return connect.NewError(connect.CodeInternal, err)
}

// forwardUnary is the shape every unary method takes: resolve, then hand the
// caller's own message to the agent unchanged.
func forwardUnary[Req any, Resp any](
	ctx context.Context,
	p *Proxy,
	req *connect.Request[Req],
	call func(context.Context, filesystemv1connect.FileBrowserClient, *connect.Request[Req]) (*connect.Response[Resp], error),
) (*connect.Response[Resp], error) {
	client, headers, err := p.connectAgent(ctx, req.Header(), any(req.Msg))
	if err != nil {
		return nil, err
	}
	out := connect.NewRequest(req.Msg)
	copyHeaders(out.Header(), headers)
	return call(ctx, client, out)
}

// forwardStream is the same for the two server-streaming methods: relay every
// message the agent produces, unmodified, until it stops.
func forwardStream[Req any, Resp any](
	ctx context.Context,
	p *Proxy,
	req *connect.Request[Req],
	stream *connect.ServerStream[Resp],
	call func(context.Context, filesystemv1connect.FileBrowserClient, *connect.Request[Req]) (*connect.ServerStreamForClient[Resp], error),
) error {
	client, headers, err := p.connectAgent(ctx, req.Header(), any(req.Msg))
	if err != nil {
		return err
	}
	out := connect.NewRequest(req.Msg)
	copyHeaders(out.Header(), headers)

	upstream, err := call(ctx, client, out)
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

func copyHeaders(dst, src http.Header) {
	for key, values := range src {
		dst[key] = values
	}
}

func (p *Proxy) ListDirectory(ctx context.Context, req *connect.Request[filesystemv1.ListDirectoryRequest]) (*connect.Response[filesystemv1.ListDirectoryResponse], error) {
	return forwardUnary(ctx, p, req, func(ctx context.Context, c filesystemv1connect.FileBrowserClient, r *connect.Request[filesystemv1.ListDirectoryRequest]) (*connect.Response[filesystemv1.ListDirectoryResponse], error) {
		return c.ListDirectory(ctx, r)
	})
}

func (p *Proxy) Stat(ctx context.Context, req *connect.Request[filesystemv1.StatRequest]) (*connect.Response[filesystemv1.StatResponse], error) {
	return forwardUnary(ctx, p, req, func(ctx context.Context, c filesystemv1connect.FileBrowserClient, r *connect.Request[filesystemv1.StatRequest]) (*connect.Response[filesystemv1.StatResponse], error) {
		return c.Stat(ctx, r)
	})
}

func (p *Proxy) Upload(ctx context.Context, req *connect.Request[filesystemv1.UploadRequest]) (*connect.Response[filesystemv1.UploadResponse], error) {
	return forwardUnary(ctx, p, req, func(ctx context.Context, c filesystemv1connect.FileBrowserClient, r *connect.Request[filesystemv1.UploadRequest]) (*connect.Response[filesystemv1.UploadResponse], error) {
		return c.Upload(ctx, r)
	})
}

func (p *Proxy) Extract(ctx context.Context, req *connect.Request[filesystemv1.ExtractRequest]) (*connect.Response[filesystemv1.ExtractResponse], error) {
	return forwardUnary(ctx, p, req, func(ctx context.Context, c filesystemv1connect.FileBrowserClient, r *connect.Request[filesystemv1.ExtractRequest]) (*connect.Response[filesystemv1.ExtractResponse], error) {
		return c.Extract(ctx, r)
	})
}

func (p *Proxy) Move(ctx context.Context, req *connect.Request[filesystemv1.MoveRequest]) (*connect.Response[filesystemv1.MoveResponse], error) {
	return forwardUnary(ctx, p, req, func(ctx context.Context, c filesystemv1connect.FileBrowserClient, r *connect.Request[filesystemv1.MoveRequest]) (*connect.Response[filesystemv1.MoveResponse], error) {
		return c.Move(ctx, r)
	})
}

func (p *Proxy) Delete(ctx context.Context, req *connect.Request[filesystemv1.DeleteRequest]) (*connect.Response[filesystemv1.DeleteResponse], error) {
	return forwardUnary(ctx, p, req, func(ctx context.Context, c filesystemv1connect.FileBrowserClient, r *connect.Request[filesystemv1.DeleteRequest]) (*connect.Response[filesystemv1.DeleteResponse], error) {
		return c.Delete(ctx, r)
	})
}

func (p *Proxy) CreateDirectory(ctx context.Context, req *connect.Request[filesystemv1.CreateDirectoryRequest]) (*connect.Response[filesystemv1.CreateDirectoryResponse], error) {
	return forwardUnary(ctx, p, req, func(ctx context.Context, c filesystemv1connect.FileBrowserClient, r *connect.Request[filesystemv1.CreateDirectoryRequest]) (*connect.Response[filesystemv1.CreateDirectoryResponse], error) {
		return c.CreateDirectory(ctx, r)
	})
}

func (p *Proxy) ReadFile(ctx context.Context, req *connect.Request[filesystemv1.ReadFileRequest], stream *connect.ServerStream[filesystemv1.ReadFileResponse]) error {
	return forwardStream(ctx, p, req, stream, func(ctx context.Context, c filesystemv1connect.FileBrowserClient, r *connect.Request[filesystemv1.ReadFileRequest]) (*connect.ServerStreamForClient[filesystemv1.ReadFileResponse], error) {
		return c.ReadFile(ctx, r)
	})
}

func (p *Proxy) Archive(ctx context.Context, req *connect.Request[filesystemv1.ArchiveRequest], stream *connect.ServerStream[filesystemv1.ArchiveResponse]) error {
	return forwardStream(ctx, p, req, stream, func(ctx context.Context, c filesystemv1connect.FileBrowserClient, r *connect.Request[filesystemv1.ArchiveRequest]) (*connect.ServerStreamForClient[filesystemv1.ArchiveResponse], error) {
		return c.Archive(ctx, r)
	})
}

// registerFileBrowser mounts the Connect handler. The read cap is generous
// enough for one upload chunk (UPLOAD_CHUNK_BYTES, 4 MiB by default) with
// room to spare, and small enough that an unbounded body cannot be used to
// exhaust this pod.
func init() {
	Register(func(mux *http.ServeMux) {
		path, handler := filesystemv1connect.NewFileBrowserHandler(
			NewProxy(),
			connect.WithReadMaxBytes(IntEnv("MAX_REQUEST_BYTES", 32<<20)),
		)
		mux.Handle(path, handler)
		// Console strips "/api/proxy/plugin/<name>/api" before proxying, so
		// the backend normally sees the bare procedure path above -- but a
		// deployment that points console at this Service without that prefix
		// stripped would not, and a 404 there is hard to tell from a plugin
		// that simply did not load.
		mux.Handle(assetPathPrefix+"/api"+path, http.StripPrefix(assetPathPrefix+"/api", handler))
		mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = fmt.Fprint(w, "ok")
		})
	})
}
