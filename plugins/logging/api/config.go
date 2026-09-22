package api

import (
	"encoding/json"
	"net/http"
	"os"
)

// PluginConfig is served as JSON at /config.json (reached by the frontend on
// console's plugin *asset* route, /api/plugins/logging-console-plugin/
// config.json, which is the only route available before any flag is set) so
// the frontend can decide whether the Node/Pod Logs tabs should be served by
// this plugin or left to console core's built-in ones.
//
// Both default to false, so an upgrade never moves a tab out from under a
// cluster on its own, but they are no longer equivalent:
//
//   - PodLogsEnabled hands the Pod details Logs tab to this plugin's own
//     viewer (src/logs/PodLogsTab.tsx), which renders JSON and ECS container
//     logs as timestamp/level/logger/message columns. That tab reads logs
//     straight off console's Kubernetes proxy under the caller's own
//     credentials, so it needs nothing from this backend and works on any
//     cluster.
//   - NodeLogsEnabled still has nothing behind it: this plugin has no Node
//     Logs tab of its own, it only repairs core's by rerouting the kubelet
//     journal requests core makes (src/fetch-patch.ts). Turning it on hides
//     core's tab with nothing to replace it.
type PluginConfig struct {
	NodeLogsEnabled bool `json:"nodeLogsEnabled"`
	PodLogsEnabled  bool `json:"podLogsEnabled"`
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
		NodeLogsEnabled: boolEnvOrDefault("NODE_LOGS_ENABLED", false),
		PodLogsEnabled:  boolEnvOrDefault("POD_LOGS_ENABLED", false),
	}
}

func init() {
	Register(func(mux *http.ServeMux) {
		for _, p := range configPaths() {
			mux.HandleFunc(p, configHandler)
		}
	})
}

// configPaths lists every path /config.json answers on. The frontend asks for
// it on console's plugin asset route, and console strips
// "/api/plugins/<ConsolePlugin name>/" before proxying, so the backend
// normally sees a bare "/config.json" -- but this image serves its assets
// under that prefix instead (assetPathPrefix), which is what an endpoint
// registered with that path in its URL delivers. Answer on both rather than
// depending on how console was pointed at this Service.
func configPaths() []string {
	paths := []string{"/config.json"}
	if prefixed := assetPathPrefix + "/config.json"; prefixed != paths[0] {
		paths = append(paths, prefixed)
	}
	return paths
}

func configHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	_ = json.NewEncoder(w).Encode(loadPluginConfig())
}
