package api

import (
	"os"
	"strconv"
	"strings"
)

func GetEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// BoolEnv reads a boolean env var, treating only "false" and "0" as false so
// a chart value rendered as `true`/`false` behaves as written.
func BoolEnv(key string, def bool) bool {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	return !strings.EqualFold(v, "false") && v != "0"
}

func IntEnv(key string, def int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

var (
	pathPrefix = GetEnv("GLOBAL_API_PATH_PREFIX", "/")
	pluginName = GetEnv("PLUGIN_NAME", "filesystem-console-plugin")

	// assetPathPrefix is where this image's embedded frontend assets live
	// (the Dockerfile copies dist/ under the same prefix). Console normally
	// strips "/api/plugins/<ConsolePlugin name>/" before proxying an asset
	// request, so the backend sees a bare "/plugin-manifest.json"; this
	// prefix only resolves when the endpoint console is pointed at carries
	// the path itself.
	assetPathPrefix = pathPrefix + "api/plugins/" + pluginName
)
