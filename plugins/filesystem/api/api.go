// Package api is the plugin backend: the half that runs as an ordinary
// Deployment, serves the frontend's Connect calls, decides whether the
// logged-in user is allowed to make them, and forwards the ones that are to
// the right node's agent.
//
// It holds no filesystem logic at all. Everything it does is answer three
// questions -- may this user do this, which node is the container on, which
// agent pod is there -- and then pass the very same RPC along.
package api

import "net/http"

// HandlerRegistrar receives the application mux and can attach routes.
type HandlerRegistrar func(*http.ServeMux)

var registrars []HandlerRegistrar

// Register lets API source files add routes from their init() functions, the
// same pattern the monitoring and logging plugins in this repo use.
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
