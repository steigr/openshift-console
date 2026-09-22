package api

import (
	"encoding/json"
	"net/http"
)

// PluginConfig is served as JSON at /config.json, which the frontend reads on
// console's plugin *asset* route -- the only route available before any
// feature flag is set, and the reason this document is not part of the gRPC
// API that everything else uses.
type PluginConfig struct {
	// PodFileBrowserEnabled gates the whole Pod "Files" tab. Unlike the
	// terminal and logging plugins' equivalents it does not hand a tab back
	// to console core, which has no file browser of its own: off simply means
	// no tab, which is what an operator wants when the agent DaemonSet is not
	// rolled out (or deliberately not wanted) on a cluster.
	PodFileBrowserEnabled bool `json:"podFileBrowserEnabled"`
	// UploadChunkBytes is how much file the frontend puts in one Upload call.
	// It is served rather than hardcoded because it has to stay under both
	// the agent's own chunk limit and whatever body size the console proxy in
	// front of it will pass.
	UploadChunkBytes int `json:"uploadChunkBytes"`
	// ViewMaxBytes caps what the in-browser viewer will load for a file.
	ViewMaxBytes int `json:"viewMaxBytes"`
	// DefaultArchiveFormat preselects the format in the folder-download menu
	// ("zip", "tar", "tar.gz" or "tar.zst").
	DefaultArchiveFormat string `json:"defaultArchiveFormat"`
}

func loadPluginConfig() PluginConfig {
	return PluginConfig{
		PodFileBrowserEnabled: BoolEnv("POD_FILE_BROWSER_ENABLED", true),
		UploadChunkBytes:      IntEnv("UPLOAD_CHUNK_BYTES", 4<<20),
		ViewMaxBytes:          IntEnv("VIEW_MAX_BYTES", 2<<20),
		DefaultArchiveFormat:  GetEnv("DEFAULT_ARCHIVE_FORMAT", "tar.gz"),
	}
}

func init() {
	Register(func(mux *http.ServeMux) {
		for _, p := range configPaths() {
			mux.HandleFunc(p, configHandler)
		}
	})
}

// configPaths lists every path /config.json answers on: console strips
// "/api/plugins/<ConsolePlugin name>/" before proxying an asset request, so
// the backend normally sees a bare "/config.json" -- but this image serves
// its assets under that prefix instead, which is what an endpoint registered
// with the path in its URL delivers. Answer on both rather than depending on
// how console was pointed at this Service.
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
