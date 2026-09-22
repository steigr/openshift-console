package agent

import (
	"crypto/subtle"
	"errors"
	"fmt"
	"log"
	"net/http"
	"runtime"
	"strings"
	"time"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	"console-filesystem-plugin/gen/filesystem/v1/filesystemv1connect"
)

// ServeOptions configure the agent's listener.
type ServeOptions struct {
	Addr string
	// Token is the shared secret the plugin backend sends. The agent is a
	// root-privileged read/write door into every container on its node, and
	// it listens on the pod network where any workload can reach its IP, so
	// it refuses to start without one unless AllowAnonymous is set
	// explicitly. The chart generates the secret and mounts it into both
	// halves.
	Token          string
	AllowAnonymous bool
	// ReadHeaderTimeout guards the listener; the handler timeouts are
	// deliberately absent, since an archive of a large directory legitimately
	// takes minutes.
	ReadHeaderTimeout time.Duration
}

// Handler builds the agent's HTTP handler: the FileBrowser service plus a
// health endpoint for the DaemonSet's probes.
//
// It is served over h2c -- plaintext HTTP/2 -- because the backend talks to
// it with the gRPC protocol, which requires HTTP/2, and the hop is pod-to-pod
// inside one node's network namespace boundary rather than something that
// crosses a cluster edge.
func Handler(svc *Service, opts ServeOptions) (http.Handler, error) {
	if opts.Token == "" && !opts.AllowAnonymous {
		return nil, errors.New("no agent token configured: set --agent-token/AGENT_TOKEN, or pass --allow-anonymous to serve every container on this node to anything that can reach this pod's IP")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	path, handler := filesystemv1connect.NewFileBrowserHandler(svc)
	mux.Handle(path, authorize(handler, opts.Token))

	h2s := &http2.Server{}
	return h2c.NewHandler(mux, h2s), nil
}

// authorize checks the shared token in constant time. An empty configured
// token means AllowAnonymous was set, and the check is skipped.
func authorize(next http.Handler, token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token != "" {
			presented := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if subtle.ConstantTimeCompare([]byte(presented), []byte(token)) != 1 {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// Serve runs the agent until the listener fails.
func Serve(svc *Service, opts ServeOptions) error {
	if !Supported {
		return fmt.Errorf("the filesystem agent needs Linux with openat2(2) (this binary was built for %s/%s); the plugin backend runs anywhere",
			runtime.GOOS, runtime.GOARCH)
	}
	handler, err := Handler(svc, opts)
	if err != nil {
		return err
	}
	if opts.ReadHeaderTimeout <= 0 {
		opts.ReadHeaderTimeout = 10 * time.Second
	}
	server := &http.Server{
		Addr:              opts.Addr,
		Handler:           handler,
		ReadHeaderTimeout: opts.ReadHeaderTimeout,
	}
	log.Printf("filesystem agent listening on %s (h2c)", opts.Addr)
	return server.ListenAndServe()
}
