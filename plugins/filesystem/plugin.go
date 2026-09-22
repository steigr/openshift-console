package main

import (
	"embed"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/spf13/cobra"

	"console-filesystem-plugin/api"
)

//go:embed dist
var staticFiles embed.FS

const staticDir = "dist"

// rootPath rewrites every request path to be relative to the embedded "dist"
// directory, which is where the built frontend assets live.
func rootPath(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")

		if r.URL.Path == "/" {
			r.URL.Path = fmt.Sprintf("/%s/", staticDir)
		} else {
			r.URL.Path = fmt.Sprintf("/%s%s", staticDir, r.URL.Path)
		}
		h.ServeHTTP(w, r)
	})
}

func runPlugin(_ *cobra.Command, _ []string) error {
	mux := http.NewServeMux()

	// The Connect handler and /config.json are registered first; http.ServeMux
	// prefers the most specific match, so the catch-all static handler below
	// only sees what they did not claim.
	api.RegisterHandlers(mux)
	mux.Handle("/", rootPath(http.FileServer(http.FS(staticFiles))))

	certFile := api.GetEnv("TLS_CERT_FILE", "/var/cert/tls.crt")
	keyFile := api.GetEnv("TLS_KEY_FILE", "/var/cert/tls.key")
	_, certStatErr := os.Stat(certFile)
	_, keyStatErr := os.Stat(keyFile)

	if certStatErr == nil && keyStatErr == nil {
		addr := ":" + api.GetEnv("PORT", "8443")
		log.Printf("filesystem plugin listening on %s (TLS)", addr)
		return http.ListenAndServeTLS(addr, certFile, keyFile, mux)
	}

	addr := ":" + api.GetEnv("PORT", "8080")
	log.Printf("filesystem plugin listening on %s (plain HTTP)", addr)
	return http.ListenAndServe(addr, mux)
}
