package api

import "os"

func GetEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

var (
	pathPrefix    = GetEnv("GLOBAL_API_PATH_PREFIX", "/")
	pluginName    = GetEnv("PLUGIN_NAME", "console-logging-plugin")
	apiPathPrefix = pathPrefix + "api/plugins/" + pluginName + "/api"

	// Where this image's embedded frontend assets live (see the Dockerfile,
	// which copies dist/ under this same prefix). Console normally strips
	// "/api/plugins/<ConsolePlugin name>/" before proxying an asset request,
	// so the backend sees a bare "/plugin-manifest.json" -- this prefix only
	// resolves when the endpoint console is pointed at carries the path
	// itself.
	assetPathPrefix = pathPrefix + "api/plugins/" + pluginName
)

func path(actionPath string) string {
	return apiPathPrefix + actionPath
}
