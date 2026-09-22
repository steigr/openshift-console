package main

import (
	"os"

	"github.com/spf13/cobra"
)

// The plugin ships as a single image with three roles: "plugin" is the
// Deployment that console talks to, "agent" is the privileged DaemonSet, and
// "helper" is the short-lived process the agent spawns inside a container's
// mount namespace -- the only one that touches a container filesystem.
//
// One image keeps their protobuf definitions from ever drifting apart, which
// is the failure mode that matters most here: all three speak the same
// service to each other. It is also what lets the agent spawn a helper at
// all, since the helper is simply this binary again.
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

	rootCmd.AddCommand(pluginCmd, newAgentCommand(), newHelperCommand())

	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}
