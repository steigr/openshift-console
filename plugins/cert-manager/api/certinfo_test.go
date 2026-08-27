package api

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakeAPIServer stands in for kube-apiserver: it serves canned objects for
// exact REST paths, and requires the expected bearer token, so tests can
// exercise certInfoHandler's full get/list flow without a real cluster.
func fakeAPIServer(t *testing.T, token string, responses map[string]interface{}) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		body, ok := responses[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{"message": "not found: " + r.URL.Path})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func testClient(srv *httptest.Server) *k8sClient {
	return &k8sClient{baseURL: srv.URL, http: srv.Client()}
}

func TestHostnamesForIngressObj(t *testing.T) {
	obj := unstructuredObject{
		"spec": map[string]interface{}{
			"rules": []interface{}{
				map[string]interface{}{"host": "a.example.com"},
				map[string]interface{}{"host": "b.example.com"},
			},
			"tls": []interface{}{
				map[string]interface{}{"hosts": []interface{}{"a.example.com", "c.example.com"}},
			},
		},
	}
	got := hostnamesForIngressObj(obj)
	want := []string{"a.example.com", "b.example.com", "c.example.com"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestHostnamesForServiceObjPrefersHostnameOverIP(t *testing.T) {
	obj := unstructuredObject{
		"status": map[string]interface{}{
			"loadBalancer": map[string]interface{}{
				"ingress": []interface{}{
					map[string]interface{}{"hostname": "lb.example.com"},
					map[string]interface{}{"ip": "10.0.0.1"},
				},
			},
		},
	}
	got := hostnamesForServiceObj(obj)
	want := []string{"lb.example.com", "10.0.0.1"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestHostnamesForRouteObj(t *testing.T) {
	obj := unstructuredObject{
		"spec": map[string]interface{}{
			"hostnames": []interface{}{"r1.example.com", "r2.example.com"},
		},
	}
	got := hostnamesForRouteObj(obj)
	want := []string{"r1.example.com", "r2.example.com"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestCertInfoHandlerGetSingleObject(t *testing.T) {
	// Ingress hostnames never carry a port (TLS is always terminated on
	// 443 by the ingress controller), so certInfoForObject always probes
	// port 443 - nothing listens there in this test, so what's being
	// verified is that the full fetch -> derive-hostname -> probe pipeline
	// ran end to end and surfaced that failure, not a successful handshake.
	const ingressHost = "web.example.internal"

	ingress := map[string]interface{}{
		"metadata": map[string]interface{}{"namespace": "ns1", "name": "web"},
		"spec": map[string]interface{}{
			"rules": []interface{}{map[string]interface{}{"host": ingressHost}},
		},
	}

	const token = "test-token"
	api := fakeAPIServer(t, token, map[string]interface{}{
		"/apis/networking.k8s.io/v1/namespaces/ns1/ingresses/web": ingress,
	})
	origBearerToken := bearerToken
	bearerToken = func() (string, error) { return token, nil }
	defer func() { bearerToken = origBearerToken }()

	client := testClient(api)

	payload := certInfoTarget{
		Group: "networking.k8s.io", Version: "v1", Kind: "Ingress",
		Namespace: "ns1", Name: "web",
	}
	rec := runCertInfoRequest(t, client, payload)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	var results []ResourceCertResult
	if err := json.Unmarshal(rec.Body.Bytes(), &results); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d: %+v", len(results), results)
	}
	got := results[0]
	if got.Namespace != "ns1" || got.Name != "web" || got.Kind != "Ingress" {
		t.Errorf("unexpected identity: %+v", got)
	}
	if got.Hostname != ingressHost || got.Port != defaultTLSPort {
		t.Errorf("unexpected target: hostname=%s port=%d", got.Hostname, got.Port)
	}
	if got.Error == "" {
		t.Errorf("expected a connection error (nothing listens on :443 in this test), got none: %+v", got)
	}
}

func TestCertInfoHandlerListNamespace(t *testing.T) {
	_, tlsHost, _ := tlsTestServer(t)

	list := map[string]interface{}{
		"items": []interface{}{
			map[string]interface{}{
				"metadata": map[string]interface{}{"namespace": "ns1", "name": "a"},
				"spec":     map[string]interface{}{"hostnames": []interface{}{tlsHost}},
			},
			map[string]interface{}{
				"metadata": map[string]interface{}{"namespace": "ns1", "name": "b"},
				"spec":     map[string]interface{}{},
			},
		},
	}

	const token = "test-token"
	api := fakeAPIServer(t, token, map[string]interface{}{
		"/apis/gateway.networking.k8s.io/v1/namespaces/ns1/httproutes": list,
	})
	origBearerToken := bearerToken
	bearerToken = func() (string, error) { return token, nil }
	defer func() { bearerToken = origBearerToken }()

	client := testClient(api)

	payload := certInfoTarget{
		Group: "gateway.networking.k8s.io", Version: "v1", Kind: "HTTPRoute",
		Namespace: "ns1",
	}
	rec := runCertInfoRequest(t, client, payload)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var results []ResourceCertResult
	if err := json.Unmarshal(rec.Body.Bytes(), &results); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 results (1 hostname + 1 no-hostname), got %d: %+v", len(results), results)
	}

	var sawHost, sawNoHost bool
	for _, r := range results {
		if r.Name == "a" && r.Hostname == tlsHost {
			sawHost = true
		}
		if r.Name == "b" && r.ResourceError != "" {
			sawNoHost = true
		}
	}
	if !sawHost || !sawNoHost {
		t.Fatalf("results missing expected entries: %+v", results)
	}
}

func TestCertInfoHandlerRejectsUnknownKind(t *testing.T) {
	const token = "test-token"
	api := fakeAPIServer(t, token, nil)
	origBearerToken := bearerToken
	bearerToken = func() (string, error) { return token, nil }
	defer func() { bearerToken = origBearerToken }()

	client := testClient(api)
	payload := certInfoTarget{Group: "example.com", Version: "v1", Kind: "Widget", Namespace: "ns1"}
	rec := runCertInfoRequest(t, client, payload)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
}

func TestCertInfoHandlerRejectsNameWithoutNamespace(t *testing.T) {
	const token = "test-token"
	api := fakeAPIServer(t, token, nil)
	origBearerToken := bearerToken
	bearerToken = func() (string, error) { return token, nil }
	defer func() { bearerToken = origBearerToken }()

	client := testClient(api)
	payload := certInfoTarget{Group: "", Version: "v1", Kind: "Service", Name: "web"}
	rec := runCertInfoRequest(t, client, payload)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
}

func TestInspectResourceHandlerFetchesSingleObject(t *testing.T) {
	const token = "test-token"
	api := fakeAPIServer(t, token, map[string]interface{}{
		"/api/v1/namespaces/ns1/services/web": map[string]interface{}{
			"metadata": map[string]interface{}{"namespace": "ns1", "name": "web"},
			"status": map[string]interface{}{
				"loadBalancer": map[string]interface{}{
					"ingress": []interface{}{map[string]interface{}{"hostname": "web.example.com"}},
				},
			},
		},
	})
	origBearerToken := bearerToken
	bearerToken = func() (string, error) { return token, nil }
	defer func() { bearerToken = origBearerToken }()

	client := testClient(api)
	rec := runInspectResourceRequest(t, client, "ns1", "~v1~Service", "web")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var results []ResourceCertResult
	if err := json.Unmarshal(rec.Body.Bytes(), &results); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(results) != 1 || results[0].Hostname != "web.example.com" {
		t.Fatalf("unexpected results: %+v", results)
	}
}

func TestInspectResourceHandlerRejectsUnknownKind(t *testing.T) {
	const token = "test-token"
	api := fakeAPIServer(t, token, nil)
	origBearerToken := bearerToken
	bearerToken = func() (string, error) { return token, nil }
	defer func() { bearerToken = origBearerToken }()

	client := testClient(api)
	rec := runInspectResourceRequest(t, client, "ns1", "example.com~v1~Widget", "thing")

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
}

func TestInspectResourceHandlerPropagatesNotFound(t *testing.T) {
	const token = "test-token"
	api := fakeAPIServer(t, token, nil)
	origBearerToken := bearerToken
	bearerToken = func() (string, error) { return token, nil }
	defer func() { bearerToken = origBearerToken }()

	client := testClient(api)
	rec := runInspectResourceRequest(t, client, "ns1", "~v1~Service", "missing")

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502: %s", rec.Code, rec.Body.String())
	}
}

// runInspectResourceRequest builds and serves an inspect request through a
// real ServeMux (so r.PathValue(...) is populated as in production),
// injecting client via inspectResourceHandlerWithClient so no real
// in-cluster environment is needed. gvk is the raw "group~version~kind"
// path segment.
func runInspectResourceRequest(t *testing.T, client *k8sClient, namespace, gvk, name string) *httptest.ResponseRecorder {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/inspect/ns/{namespace}/{gvk}/{name}", func(w http.ResponseWriter, r *http.Request) {
		inspectResourceHandlerWithClient(w, r, client)
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/inspect/ns/"+namespace+"/"+gvk+"/"+name, nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// runCertInfoRequest builds and serves a certinfo request through a real
// ServeMux (so r.PathValue("payload") is populated as in production),
// injecting client via certInfoHandlerWithClient so no real in-cluster
// environment is needed.
func runCertInfoRequest(t *testing.T, client *k8sClient, target certInfoTarget) *httptest.ResponseRecorder {
	t.Helper()
	payloadJSON, err := json.Marshal(target)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	payload := base64.RawURLEncoding.EncodeToString(payloadJSON)

	mux := http.NewServeMux()
	mux.HandleFunc(basePath+"/api/v1/certinfo/{payload}", func(w http.ResponseWriter, r *http.Request) {
		certInfoHandlerWithClient(w, r, client)
	})

	req := httptest.NewRequest(http.MethodGet, basePath+"/api/v1/certinfo/"+payload, nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestResourcePath(t *testing.T) {
	cases := []struct {
		group, version, plural, namespace, name string
		want                                    string
	}{
		{"", "v1", "services", "ns1", "web", "/api/v1/namespaces/ns1/services/web"},
		{"", "v1", "services", "", "", "/api/v1/services"},
		{"gateway.networking.k8s.io", "v1", "httproutes", "ns1", "", "/apis/gateway.networking.k8s.io/v1/namespaces/ns1/httproutes"},
	}
	for i, c := range cases {
		got := resourcePath(c.group, c.version, c.plural, c.namespace, c.name)
		if got != c.want {
			t.Errorf("case %d: got %q, want %q", i, got, c.want)
		}
	}
}
