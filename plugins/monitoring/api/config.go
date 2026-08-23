package api

import (
	"encoding/json"
	"net/http"
	"os"
)

// PlatformAccessReview mirrors the group/resource/name used by the two
// SelfSubjectAccessReview checks in web/src/contexts/MonitoringContext.tsx
// that decide whether the current user has cluster-wide (non-tenancy)
// access to alerts/metrics.
type PlatformAccessReview struct {
	Group           string `json:"group"`
	AlertsResource  string `json:"alertsResource"`
	MetricsResource string `json:"metricsResource"`
	MetricsName     string `json:"metricsName"`
}

// PluginConfig is served as JSON at /config.json (proxied by console at
// /api/plugins/monitoring-plugin/config.json) so the frontend can tell a
// non-CMO Prometheus-compatible stack (e.g. VictoriaMetrics) apart from the
// OpenShift default without hardcoding CMO's labels/RBAC. See
// VICTORIA-METRICS-TODO.md items 2 and 3.
type PluginConfig struct {
	PlatformPrometheusLabel string               `json:"platformPrometheusLabel"`
	PlatformAccessReview    PlatformAccessReview `json:"platformAccessReview"`
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func loadPluginConfig() PluginConfig {
	return PluginConfig{
		PlatformPrometheusLabel: envOrDefault("PLATFORM_PROMETHEUS_LABEL", "openshift-monitoring/k8s"),
		PlatformAccessReview: PlatformAccessReview{
			Group:           envOrDefault("PLATFORM_ACCESS_REVIEW_GROUP", "monitoring.coreos.com"),
			AlertsResource:  envOrDefault("PLATFORM_ALERTS_ACCESS_REVIEW_RESOURCE", "prometheusrules"),
			MetricsResource: envOrDefault("PLATFORM_METRICS_ACCESS_REVIEW_RESOURCE", "prometheuses/api"),
			MetricsName:     envOrDefault("PLATFORM_METRICS_ACCESS_REVIEW_NAME", "k8s"),
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
