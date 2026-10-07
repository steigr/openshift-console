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
//
// ColorScheme names the terminal palette per console theme (light/dark), from
// TERMINAL_COLOR_SCHEME_LIGHT/_DARK; the frontend knows the palettes
// (src/shared/colorSchemes.ts) and falls back to xterm's default for an empty
// or unknown name.
type PluginConfig struct {
	PodTerminalEnabled  bool        `json:"podTerminalEnabled"`
	NodeTerminalEnabled bool        `json:"nodeTerminalEnabled"`
	ColorScheme         ColorScheme `json:"colorScheme"`
}

// ColorScheme is a color scheme name per console theme.
type ColorScheme struct {
	Light string `json:"light"`
	Dark  string `json:"dark"`
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
		ColorScheme: ColorScheme{
			Light: os.Getenv("TERMINAL_COLOR_SCHEME_LIGHT"),
			Dark:  os.Getenv("TERMINAL_COLOR_SCHEME_DARK"),
		},
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
