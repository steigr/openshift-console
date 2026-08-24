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
	pluginName    = GetEnv("PLUGIN_NAME", "console-node-logging-plugin")
	apiPathPrefix = pathPrefix + "api/plugins/" + pluginName + "/api"
)

func path(actionPath string) string {
	return apiPathPrefix + actionPath
}
