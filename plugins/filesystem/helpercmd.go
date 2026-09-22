package main

import (
	"fmt"

	"github.com/spf13/cobra"

	"console-filesystem-plugin/internal/helper"
)

// newHelperCommand is the process the agent spawns, one per container being
// browsed.
//
// It is not meant to be run by hand: it expects a connected socket on fd 3
// and it joins another process's mount namespace before doing anything else.
// The flags exist because the agent passes its own limits down, so the two
// halves cannot disagree about them, and because an operator debugging on a
// node can then reproduce exactly what the agent ran.
func newHelperCommand() *cobra.Command {
	cfg := helper.DefaultConfig()
	var targetPID int

	cmd := &cobra.Command{
		Use:    "helper",
		Short:  "Serve one container's filesystem from inside its mount namespace (spawned by the agent)",
		Args:   cobra.NoArgs,
		Hidden: true,
		RunE: func(_ *cobra.Command, _ []string) error {
			if targetPID <= 0 {
				return fmt.Errorf("--target-pid is required: the helper is spawned by the agent, not run by hand")
			}
			// Two-stage start: the first pass joins the container's mount
			// namespace and re-executes this binary inside it, so every
			// thread the new runtime spawns is in there too. Only the second
			// pass serves -- see helper.Enter for why a single pass would
			// quietly answer out of the agent's own filesystem instead.
			if !helper.Entered() {
				return helper.Enter(targetPID)
			}
			conn, err := helper.ControlConn()
			if err != nil {
				return err
			}
			defer conn.Close()
			return helper.Serve(cfg, conn)
		},
	}

	flags := cmd.Flags()
	flags.IntVar(&targetPID, "target-pid", 0, "PID, in the host's numbering, of a process in the container to serve")
	flags.IntVar(&cfg.MaxListEntries, "max-list-entries", cfg.MaxListEntries, "most directory entries returned in one listing")
	flags.Int64Var(&cfg.MaxReadBytes, "max-read-bytes", cfg.MaxReadBytes, "largest file served in one read")
	flags.Int64Var(&cfg.MaxArchiveBytes, "max-archive-bytes", cfg.MaxArchiveBytes, "largest tar produced for a folder download")
	flags.IntVar(&cfg.MaxArchiveEntries, "max-archive-entries", cfg.MaxArchiveEntries, "most entries packed into one archive")
	flags.Int64Var(&cfg.MaxExtractBytes, "max-extract-bytes", cfg.MaxExtractBytes, "most bytes one extraction may unpack")
	flags.IntVar(&cfg.MaxExtractEntries, "max-extract-entries", cfg.MaxExtractEntries, "most entries one extraction may unpack")
	flags.IntVar(&cfg.MaxUploadChunk, "max-upload-chunk", cfg.MaxUploadChunk, "largest accepted upload chunk")
	flags.IntVar(&cfg.ChunkSize, "chunk-size", cfg.ChunkSize, "how much of a file or archive rides in one stream message")

	return cmd
}
