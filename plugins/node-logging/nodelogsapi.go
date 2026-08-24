package main

import (
	"bytes"
	"context"
	"fmt"
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

	"console-node-logging-plugin/api"
)

const (
	defaultTailLines = 1000
	maxTailLines     = 10000
	maxUnits         = 20
	journalTimeout   = 30 * time.Second
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

func parseJournalQuery(r *http.Request) (units []string, tailLines int, err error) {
	tailLines = defaultTailLines
	if tail := r.URL.Query().Get("tailLines"); tail != "" {
		// 0 means unlimited (no -n flag; used by the raw journal view).
		n, parseErr := strconv.Atoi(tail)
		if parseErr != nil || n < 0 || n > maxTailLines {
			return nil, 0, fmt.Errorf("tailLines must be an integer between 0 and %d", maxTailLines)
		}
		tailLines = n
	}

	for _, unit := range r.URL.Query()["unit"] {
		if unit == "" {
			continue
		}
		if !unitRE.MatchString(unit) {
			return nil, 0, fmt.Errorf("invalid unit name %q", unit)
		}
		units = append(units, unit)
	}
	if len(units) > maxUnits {
		return nil, 0, fmt.Errorf("at most %d units may be requested", maxUnits)
	}
	return units, tailLines, nil
}

func journalHandler(w http.ResponseWriter, r *http.Request) {
	units, tailLines, err := parseJournalQuery(r)
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

	// -r: newest entries first; -W: omit the hostname field.
	args := []string{"--no-pager", "--utc", "-r", "-W"}
	if tailLines > 0 {
		args = append(args, "-n", strconv.Itoa(tailLines))
	}
	for _, unit := range units {
		args = append(args, "-u", unit)
	}

	ctx, cancel := context.WithTimeout(r.Context(), journalTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, journalctl, args...)
	if root != "" {
		cmd.SysProcAttr = &syscall.SysProcAttr{Chroot: root}
		cmd.Dir = "/"
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	log.Printf("running %s %v (chroot=%q)", journalctl, args, root)
	if err := cmd.Run(); err != nil {
		log.Printf("journalctl failed: %v: %s", err, stderr.String())
		http.Error(
			w,
			fmt.Sprintf("journalctl failed: %v: %s", err, stderr.String()),
			http.StatusBadGateway,
		)
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(stdout.Bytes())
}
