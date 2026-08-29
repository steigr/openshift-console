package api

import (
	"encoding/json"
	"net/http"
	"os"
)

// PluginConfig is served as JSON at /config.json (proxied by console at
// /api/plugins/terminal-console-plugin/config.json) so the frontend can decide
// whether the Pod/Node Terminal tabs should be served by this plugin or left
// to console core's built-in ones. Toggling either env var to "false" hands
// that tab back to core without redeploying the plugin's frontend.
type PluginConfig struct {
	PodTerminalEnabled  bool `json:"podTerminalEnabled"`
	NodeTerminalEnabled bool `json:"nodeTerminalEnabled"`
}

func boolEnvOrDefault(key string, def bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	return v != "false" && v != "0"
}

func loadPluginConfig() PluginConfig {
	return PluginConfig{
		PodTerminalEnabled:  boolEnvOrDefault("POD_TERMINAL_ENABLED", true),
		NodeTerminalEnabled: boolEnvOrDefault("NODE_TERMINAL_ENABLED", true),
	}
}

func init() {
	Register(func(mux *http.ServeMux) {
		mux.HandleFunc("/config.json", configHandler)
	})
}

func configHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	json.NewEncoder(w).Encode(loadPluginConfig())
}
