package api

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestConfigHandlerColorScheme(t *testing.T) {
	t.Setenv("TERMINAL_COLOR_SCHEME_LIGHT", "solarized-light")
	t.Setenv("TERMINAL_COLOR_SCHEME_DARK", "solarized-dark")
	t.Setenv("TERMINAL_BACKGROUND", "console")

	rec := httptest.NewRecorder()
	configHandler(rec, httptest.NewRequest("GET", "/config.json", nil))

	var got PluginConfig
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	want := ColorScheme{Light: "solarized-light", Dark: "solarized-dark", Background: "console"}
	if got.ColorScheme != want {
		t.Errorf("colorScheme = %+v, want %+v", got.ColorScheme, want)
	}
	if !got.PodTerminalEnabled || !got.NodeTerminalEnabled {
		t.Errorf("terminals disabled by default: %+v", got)
	}
}
