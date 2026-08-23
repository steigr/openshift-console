# console-networking-plugin

## Patch layout

- `patches/frontend`: patches applied in the frontend stage against `openshift/networking-console-plugin`
- `patches/backend`: patches applied in the backend (Go builder) stage against this project sources

## Backend patch hooks

This project now includes a placeholder backend package at `api/`.

Patch files can add HTTP handlers by dropping a `.go` file into the `api` package and registering routes in `init()`.

Example:

```go
package api

import "net/http"

func init() {
	Register(func(mux *http.ServeMux) {
		mux.HandleFunc("/api/example", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		})
	})
}
```

`main.go` creates a shared `http.ServeMux`, calls `api.RegisterHandlers(mux)`, and then serves static assets and any registered API routes from that mux.

