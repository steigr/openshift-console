package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRegisterHandlersWithoutRegistrars(t *testing.T) {
	original := registrars
	registrars = nil
	t.Cleanup(func() {
		registrars = original
	})

	mux := http.NewServeMux()
	RegisterHandlers(mux)

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)

	if res.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d", http.StatusNotFound, res.Code)
	}
}

func TestRegisterHandlersWithPatchRegistrar(t *testing.T) {
	original := registrars
	registrars = nil
	t.Cleanup(func() {
		registrars = original
	})

	Register(func(mux *http.ServeMux) {
		mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		})
	})

	mux := http.NewServeMux()
	RegisterHandlers(mux)

	req := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)

	if res.Code != http.StatusNoContent {
		t.Fatalf("expected status %d, got %d", http.StatusNoContent, res.Code)
	}
}
