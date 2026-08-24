package main

import (
	"embed"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/spf13/cobra"

	"console-node-logging-plugin/api"
)

//go:embed dist
var staticFiles embed.FS

const staticDir = "dist"

// rootPath rewrites every request path to be relative to the embedded
// "dist" directory, which is where the built frontend assets live.
func rootPath(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")

		if r.URL.Path == "/" {
			r.URL.Path = fmt.Sprintf("/%s/", staticDir)
		} else {
			r.URL.Path = fmt.Sprintf("/%s%s", staticDir, r.URL.Path)
		}

		log.Printf("%s %s", r.Method, r.URL.Path)
		h.ServeHTTP(w, r)
	})
}

func runPlugin(_ *cobra.Command, _ []string) error {
	mux := http.NewServeMux()

	// Custom API routes take precedence over the catch-all static handler
	// registered below, since http.ServeMux prefers the most specific match.
	api.RegisterHandlers(mux)

	mux.Handle("/", rootPath(http.FileServer(http.FS(staticFiles))))

	certFile := api.GetEnv("TLS_CERT_FILE", "/var/cert/tls.crt")
	keyFile := api.GetEnv("TLS_KEY_FILE", "/var/cert/tls.key")
	_, certStatErr := os.Stat(certFile)
	_, keyStatErr := os.Stat(keyFile)

	if certStatErr == nil && keyStatErr == nil {
		port := api.GetEnv("PORT", "8443")
		addr := fmt.Sprintf(":%s", port)
		log.Printf("Listening on %s (TLS)...\n", addr)
		return http.ListenAndServeTLS(addr, certFile, keyFile, mux)
	}

	port := api.GetEnv("PORT", "8080")
	addr := fmt.Sprintf(":%s", port)
	log.Printf("Listening on %s (plain HTTP)...\n", addr)
	return http.ListenAndServe(addr, mux)
}
