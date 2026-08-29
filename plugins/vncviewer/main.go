package main

import (
	"embed"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"console-plugin/api"
)

//go:embed dist
var staticFiles embed.FS

var (
	staticDir   = "dist"
	defaultPort = "8080"
)

func rootPath(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")

		if r.URL.Path == "/" {
			r.URL.Path = fmt.Sprintf("/%s/", staticDir)
		} else {
			b := strings.Split(r.URL.Path, "/")[0]
			if b != staticDir {
				r.URL.Path = fmt.Sprintf("/%s%s", staticDir, r.URL.Path)
			}
		}
		log.Printf("%s %s", r.Method, r.URL.Path)
		h.ServeHTTP(w, r)
	})
}

func main() {

	var staticFS = http.FS(staticFiles)
	fs := rootPath(http.FileServer(staticFS))
	mux := http.NewServeMux()

	api.RegisterHandlers(mux)

	mux.Handle("/", fs)

	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	log.Printf("Listening on :%s...\n", port)
	err := http.ListenAndServe(fmt.Sprintf(":%s", port), mux)
	if err != nil {
		log.Fatal(err)
	}
}
