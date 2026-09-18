package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLoadPluginConfigDefaultsToOff(t *testing.T) {
	t.Setenv("NODE_LOGS_ENABLED", "")
	t.Setenv("POD_LOGS_ENABLED", "")

	cfg := loadPluginConfig()
	if cfg.NodeLogsEnabled || cfg.PodLogsEnabled {
		t.Fatalf("expected both tabs left to console core by default, got %+v", cfg)
	}
}

func TestLoadPluginConfigFromEnv(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  bool
	}{
		{"true", true},
		{"1", true},
		{"yes", true},
		{"false", false},
		{"0", false},
	} {
		t.Setenv("NODE_LOGS_ENABLED", tc.value)
		t.Setenv("POD_LOGS_ENABLED", tc.value)

		cfg := loadPluginConfig()
		if cfg.NodeLogsEnabled != tc.want || cfg.PodLogsEnabled != tc.want {
			t.Errorf("%q: want %v, got %+v", tc.value, tc.want, cfg)
		}
	}
}

func TestConfigHandlerServesJSON(t *testing.T) {
	t.Setenv("NODE_LOGS_ENABLED", "true")
	t.Setenv("POD_LOGS_ENABLED", "false")

	recorder := httptest.NewRecorder()
	configHandler(recorder, httptest.NewRequest(http.MethodGet, "/config.json", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type: want application/json, got %q", got)
	}

	var cfg PluginConfig
	if err := json.Unmarshal(recorder.Body.Bytes(), &cfg); err != nil {
		t.Fatalf("decoding body %q: %v", recorder.Body.String(), err)
	}
	if !cfg.NodeLogsEnabled || cfg.PodLogsEnabled {
		t.Errorf("want node logs on and pod logs off, got %+v", cfg)
	}
}

func TestConfigPathsCoverBothAssetRoutes(t *testing.T) {
	paths := configPaths()

	if len(paths) == 0 || paths[0] != "/config.json" {
		t.Fatalf("want the stripped asset path first, got %v", paths)
	}
	// The prefixed path is only added when it differs, so a plugin served at
	// the root registers a single route rather than the same one twice.
	want := assetPathPrefix + "/config.json"
	if want == "/config.json" {
		if len(paths) != 1 {
			t.Fatalf("want a single route, got %v", paths)
		}
		return
	}
	if len(paths) != 2 || paths[1] != want {
		t.Fatalf("want %q registered as well, got %v", want, paths)
	}
}
