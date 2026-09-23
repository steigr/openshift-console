package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"console-logging-plugin/api"
)

const (
	defaultTailLines = 1000
	maxTailLines     = 10000
	maxUnits         = 20
	journalTimeout   = 30 * time.Second
	// An unlimited read walks the whole journal, which on a long-lived node
	// is far more than a tail and needs correspondingly longer.
	journalFullTimeout = 5 * time.Minute
)

// Systemd unit names; the leading character set excludes '-' so a unit can
// never be parsed as a journalctl flag.
var unitRE = regexp.MustCompile(`^[A-Za-z0-9@:._][A-Za-z0-9@:._-]*$`)

var journalctlCandidates = []string{"/usr/bin/journalctl", "/bin/journalctl"}

func newNodeLogsAPICommand() *cobra.Command {
	return &cobra.Command{
		Use:   "node-logs-api",
		Short: "Serve systemd journal logs from the local node",
		Args:  cobra.NoArgs,
		RunE:  runNodeLogsAPI,
	}
}

func runNodeLogsAPI(_ *cobra.Command, _ []string) error {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /journal", journalHandler)

	port := api.GetEnv("PORT", "9080")
	addr := fmt.Sprintf(":%s", port)
	log.Printf("node-logs-api listening on %s...\n", addr)
	return http.ListenAndServe(addr, mux)
}

// hostRoot returns the host filesystem mount to chroot into, or "" when
// journalctl should run directly (no chroot).
func hostRoot() string {
	root := api.GetEnv("HOST_ROOT", "/host")
	if root == "" || root == "/" {
		return ""
	}
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		return ""
	}
	return root
}

// findJournalctl locates the journalctl binary, either inside the host
// chroot or on the regular PATH.
func findJournalctl(root string) (string, error) {
	if root != "" {
		for _, candidate := range journalctlCandidates {
			if _, err := os.Stat(filepath.Join(root, candidate)); err == nil {
				return candidate, nil
			}
		}
		return "", fmt.Errorf("journalctl not found under %s", root)
	}
	if path, err := exec.LookPath("journalctl"); err == nil {
		return path, nil
	}
	for _, candidate := range journalctlCandidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("journalctl not found")
}

// journalQuery is one parsed request for journal content.
type journalQuery struct {
	units     []string
	tailLines int
	// JSON per line (journalctl -o json) rather than the human-readable
	// syslog-ish text. The plugin's own Node Logs tab asks for this so it can
	// render the fields as columns; console core's tab, which this backend
	// also serves through the frontend's fetch patch, does not and must keep
	// getting text.
	asJSON bool
}

func parseJournalQuery(r *http.Request) (q journalQuery, err error) {
	q.tailLines = defaultTailLines
	if tail := r.URL.Query().Get("tailLines"); tail != "" {
		// 0 means unlimited (no -n flag; used by the raw journal view).
		n, parseErr := strconv.Atoi(tail)
		if parseErr != nil || n < 0 || n > maxTailLines {
			return q, fmt.Errorf("tailLines must be an integer between 0 and %d", maxTailLines)
		}
		q.tailLines = n
	}

	switch output := r.URL.Query().Get("output"); output {
	case "", "short":
		q.asJSON = false
	case "json":
		q.asJSON = true
	default:
		return q, fmt.Errorf("output must be %q or %q", "short", "json")
	}

	for _, unit := range r.URL.Query()["unit"] {
		if unit == "" {
			continue
		}
		if !unitRE.MatchString(unit) {
			return q, fmt.Errorf("invalid unit name %q", unit)
		}
		q.units = append(q.units, unit)
	}
	if len(q.units) > maxUnits {
		return q, fmt.Errorf("at most %d units may be requested", maxUnits)
	}
	return q, nil
}

func journalHandler(w http.ResponseWriter, r *http.Request) {
	query, err := parseJournalQuery(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	root := hostRoot()
	journalctl, err := findJournalctl(root)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// -W: omit the hostname field.
	args := []string{"--no-pager", "--utc", "-W"}
	if query.asJSON {
		// Chronological, unlike the text form below: the plugin's viewer
		// reads top to bottom and pins to the newest line at the bottom, the
		// same as a container log. -r would stand that on its head.
		args = append(args, "-o", "json")
	} else {
		// -r: newest entries first, which is the order console core's own
		// Node Logs tab expects.
		args = append(args, "-r")
	}
	if query.tailLines > 0 {
		args = append(args, "-n", strconv.Itoa(query.tailLines))
	}
	for _, unit := range query.units {
		args = append(args, "-u", unit)
	}

	timeout := journalTimeout
	if query.tailLines == 0 {
		timeout = journalFullTimeout
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, journalctl, args...)
	if root != "" {
		cmd.SysProcAttr = &syscall.SysProcAttr{Chroot: root}
		cmd.Dir = "/"
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	log.Printf("running %s %v (chroot=%q)", journalctl, args, root)
	if err := cmd.Start(); err != nil {
		log.Printf("journalctl failed to start: %v", err)
		http.Error(w, fmt.Sprintf("journalctl failed: %v", err), http.StatusBadGateway)
		return
	}

	// Streamed, not buffered: an unlimited read is the whole journal, which on
	// a busy node is orders of magnitude more than fits comfortably in this
	// DaemonSet's memory limit. The status line therefore has to be written
	// before the first byte of output, so a journalctl that fails partway
	// through can only be reported in the log below -- the client sees a
	// truncated body, which is the usual bargain for a streamed response.
	if query.asJSON {
		w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if _, err := io.Copy(&flushWriter{w}, stdout); err != nil {
		log.Printf("journal: streaming output: %v", err)
	}

	if err := cmd.Wait(); err != nil {
		log.Printf("journalctl failed: %v: %s", err, stderr.String())
	}
}

// flushWriter pushes each chunk to the client as it is produced, so the tab
// fills progressively instead of waiting for journalctl to finish.
type flushWriter struct {
	w http.ResponseWriter
}

func (f *flushWriter) Write(p []byte) (int, error) {
	n, err := f.w.Write(p)
	if flusher, ok := f.w.(http.Flusher); ok {
		flusher.Flush()
	}
	return n, err
}
