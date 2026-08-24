package api

import "net/http"

// HandlerRegistrar receives the application mux and can attach routes.
type HandlerRegistrar func(*http.ServeMux)

var registrars []HandlerRegistrar

// Register lets API source files add routes from their init() functions.
func Register(registrar HandlerRegistrar) {
	if registrar == nil {
		return
	}
	registrars = append(registrars, registrar)
}

// RegisterHandlers mounts all registered API handlers onto the provided mux.
func RegisterHandlers(mux *http.ServeMux) {
	if mux == nil {
		return
	}

	for _, registrar := range registrars {
		registrar(mux)
	}
}
