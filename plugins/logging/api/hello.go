package api

import (
	"encoding/json"
	"net/http"
)

func init() {
	Register(func(mux *http.ServeMux) {
		mux.HandleFunc(path("/hello-world"), helloWorldHandler)
	})
}

func helloWorldHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"message": "Hello World"})
}
