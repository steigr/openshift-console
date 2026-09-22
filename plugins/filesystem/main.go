package main

import (
	"os"

	"github.com/spf13/cobra"
)

// The plugin ships as a single image with two roles, the way the logging
// plugin in this repo does: "plugin" is the Deployment that console talks to,
// "agent" is the privileged DaemonSet that actually touches container
// filesystems. One image keeps the two halves' protobuf definitions from ever
// drifting apart, which is the failure mode that matters most here -- they
// speak the same service to each other.
func main() {
	rootCmd := &cobra.Command{
		Use:          "filesystem-plugin",
		Short:        "OpenShift console filesystem plugin",
		SilenceUsage: true,
		Args:         cobra.NoArgs,
		RunE:         runPlugin,
	}

	pluginCmd := &cobra.Command{
		Use:   "plugin",
		Short: "Serve console plugin assets and the FileBrowser API (default)",
		Args:  cobra.NoArgs,
		RunE:  runPlugin,
	}

	rootCmd.AddCommand(pluginCmd, newAgentCommand())

	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}
