package main

import (
	"os"

	"github.com/spf13/cobra"
)

func main() {
	rootCmd := &cobra.Command{
		Use:          "node-logging-plugin",
		Short:        "OpenShift console node-logging plugin",
		SilenceUsage: true,
		Args:         cobra.NoArgs,
		RunE:         runPlugin,
	}

	pluginCmd := &cobra.Command{
		Use:   "plugin",
		Short: "Serve console plugin assets and API (default)",
		Args:  cobra.NoArgs,
		RunE:  runPlugin,
	}

	rootCmd.AddCommand(pluginCmd, newNodeLogsAPICommand())

	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}
