package main

import (
	"time"

	"github.com/spf13/cobra"

	"console-filesystem-plugin/api"
	"console-filesystem-plugin/internal/agent"
)

// newAgentCommand builds the DaemonSet half.
//
// Every knob is a flag with an environment-variable default, because the two
// ways these get set in practice are a chart value (which becomes an env var
// on the DaemonSet) and an operator debugging on a node (who reaches for a
// flag). --archive-compression-level is the one the requirements name
// explicitly; the rest are the limits that keep a single click from
// exhausting a node, and the lifetime knobs that keep a helper from holding a
// container's mount namespace longer than it has to.
func newAgentCommand() *cobra.Command {
	cfg := agent.DefaultConfig()
	opts := agent.ServeOptions{}

	cmd := &cobra.Command{
		Use:   "agent",
		Short: "Serve container filesystems from this node (runs as the privileged DaemonSet)",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			service, err := agent.NewService(cfg)
			if err != nil {
				return err
			}
			return agent.Serve(service, opts)
		},
	}

	flags := cmd.Flags()
	flags.StringVar(&opts.Addr, "listen", ":"+api.GetEnv("PORT", "9090"),
		"address to serve the gRPC API on")
	flags.StringVar(&opts.Token, "agent-token", api.GetEnv("AGENT_TOKEN", ""),
		"shared secret the plugin backend must present; without it the agent refuses to start")
	flags.BoolVar(&opts.AllowAnonymous, "allow-anonymous", api.BoolEnv("ALLOW_ANONYMOUS", false),
		"serve without a token -- every container on this node becomes readable and writable by anything that can reach this pod")
	flags.DurationVar(&cfg.PIDCacheTTL, "pid-cache-ttl", time.Duration(api.IntEnv("PID_CACHE_TTL_SECONDS", 30))*time.Second,
		"how long a container's resolved PID is reused before /proc is rescanned")
	flags.StringVar(&cfg.ProcRoot, "proc-root", api.GetEnv("PROC_ROOT", "/proc"),
		"where the host's procfs is mounted")

	flags.DurationVar(&cfg.HelperGrace, "helper-grace", time.Duration(api.IntEnv("HELPER_GRACE_SECONDS", 15))*time.Second,
		"how long a helper stays after its last call, so clicking around a tree does not pay for a respawn. A helper holds its container's mount namespace alive, so this is deliberately short; a container that exits drops its helper immediately regardless")
	flags.IntVar(&cfg.MaxHelpers, "max-helpers", api.IntEnv("MAX_HELPERS", cfg.MaxHelpers),
		"most containers this node will browse at once")

	flags.IntVar(&cfg.CompressionLevel, "archive-compression-level", api.IntEnv("ARCHIVE_COMPRESSION_LEVEL", 0),
		"0-9 compression level for folder downloads; 0 uses each codec's own default. Maps to deflate for zip and tar.gz, and to zstd's fastest/default/better/best levels for tar.zst")
	flags.IntVar(&cfg.MaxListEntries, "max-list-entries", api.IntEnv("MAX_LIST_ENTRIES", cfg.MaxListEntries),
		"most directory entries returned in one listing")
	flags.Int64Var(&cfg.MaxReadBytes, "max-read-bytes", int64(api.IntEnv("MAX_READ_BYTES", int(cfg.MaxReadBytes))),
		"largest file served in one read")
	flags.Int64Var(&cfg.MaxArchiveBytes, "max-archive-bytes", int64(api.IntEnv("MAX_ARCHIVE_BYTES", int(cfg.MaxArchiveBytes))),
		"largest archive produced for a folder download, measured before compression")
	flags.IntVar(&cfg.MaxArchiveEntries, "max-archive-entries", api.IntEnv("MAX_ARCHIVE_ENTRIES", cfg.MaxArchiveEntries),
		"most entries packed into one archive")
	flags.Int64Var(&cfg.MaxExtractBytes, "max-extract-bytes", int64(api.IntEnv("MAX_EXTRACT_BYTES", int(cfg.MaxExtractBytes))),
		"most bytes one extraction may unpack, the guard against an archive that unpacks to far more than it weighs")
	flags.IntVar(&cfg.MaxExtractEntries, "max-extract-entries", api.IntEnv("MAX_EXTRACT_ENTRIES", cfg.MaxExtractEntries),
		"most entries one extraction may unpack")
	flags.IntVar(&cfg.MaxUploadChunk, "max-upload-chunk", api.IntEnv("MAX_UPLOAD_CHUNK", cfg.MaxUploadChunk),
		"largest accepted upload chunk")
	flags.IntVar(&cfg.ChunkSize, "chunk-size", api.IntEnv("CHUNK_SIZE", cfg.ChunkSize),
		"how much of a file or archive rides in one stream message")

	return cmd
}
