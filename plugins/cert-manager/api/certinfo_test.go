package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakeAPIServer stands in for kube-apiserver: it serves canned objects for
// exact REST paths, and requires the expected bearer token, so tests can
// exercise inspectResourceHandler's full get flow without a real cluster.
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

func TestAnnotationHostnamesReadsBothAnnotations(t *testing.T) {
	obj := unstructuredObject{
		"metadata": map[string]interface{}{
			"annotations": map[string]interface{}{
				externalDNSHostnameAnnotation:         "a.example.com, b.example.com",
				externalDNSInternalHostnameAnnotation: "internal.example.com",
			},
		},
	}
	hosts, excluded := annotationHostnames(obj)
	if excluded {
		t.Fatal("expected not excluded")
	}
	want := []string{"a.example.com", "b.example.com", "internal.example.com"}
	if fmt.Sprint(hosts) != fmt.Sprint(want) {
		t.Fatalf("got %v, want %v", hosts, want)
	}
}

func TestAnnotationHostnamesHonorsExclude(t *testing.T) {
	obj := unstructuredObject{
		"metadata": map[string]interface{}{
			"annotations": map[string]interface{}{
				externalDNSHostnameAnnotation: "a.example.com",
				externalDNSExcludeAnnotation:  "true",
			},
		},
	}
	hosts, excluded := annotationHostnames(obj)
	if !excluded {
		t.Fatal("expected excluded")
	}
	if len(hosts) != 0 {
		t.Fatalf("expected no hosts when excluded, got %v", hosts)
	}
}

func TestCertInfoForObjectMergesStructuralAndAnnotationHostnames(t *testing.T) {
	obj := unstructuredObject{
		"metadata": map[string]interface{}{
			"namespace":   "ns1",
			"name":        "web",
			"annotations": map[string]interface{}{externalDNSHostnameAnnotation: "annotated.example.com"},
		},
		"spec": map[string]interface{}{
			"rules": []interface{}{map[string]interface{}{"host": "structural.example.com"}},
		},
	}
	results := certInfoForObject(t.Context(), "Ingress", kindRegistry["Ingress"], obj)
	if len(results) != 2 {
		t.Fatalf("expected 2 results (structural + annotation), got %+v", results)
	}
	var sawStructural, sawAnnotated bool
	for _, r := range results {
		if r.Hostname == "structural.example.com" {
			sawStructural = true
		}
		if r.Hostname == "annotated.example.com" {
			sawAnnotated = true
		}
	}
	if !sawStructural || !sawAnnotated {
		t.Fatalf("expected both hostnames, got %+v", results)
	}
}

func TestCertInfoForObjectRespectsExcludeAnnotation(t *testing.T) {
	obj := unstructuredObject{
		"metadata": map[string]interface{}{
			"namespace":   "ns1",
			"name":        "web",
			"annotations": map[string]interface{}{externalDNSExcludeAnnotation: "true"},
		},
		"spec": map[string]interface{}{
			"rules": []interface{}{map[string]interface{}{"host": "structural.example.com"}},
		},
	}
	results := certInfoForObject(t.Context(), "Ingress", kindRegistry["Ingress"], obj)
	if len(results) != 1 || results[0].ResourceError == "" {
		t.Fatalf("expected a single excluded result, got %+v", results)
	}
}

func TestInspectResourceHandlerFetchesAnnotationOnlyNode(t *testing.T) {
	const token = "test-token"
	api := fakeAPIServer(t, token, map[string]interface{}{
		"/api/v1/nodes/node-1": map[string]interface{}{
			"metadata": map[string]interface{}{
				"name":        "node-1",
				"annotations": map[string]interface{}{externalDNSHostnameAnnotation: "node-1.example.com"},
			},
		},
	})
	origBearerToken := bearerToken
	bearerToken = func() (string, error) { return token, nil }
	defer func() { bearerToken = origBearerToken }()

	client := testClient(api)
	rec := runInspectResourceRequest(t, client, clusterScopedSegment, "~v1~Node", "node-1")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var results []ResourceCertResult
	if err := json.Unmarshal(rec.Body.Bytes(), &results); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(results) != 1 || results[0].Hostname != "node-1.example.com" {
		t.Fatalf("unexpected results: %+v", results)
	}
}

func TestInspectResourceHandlerRejectsNamespaceForClusterScopedKind(t *testing.T) {
	const token = "test-token"
	api := fakeAPIServer(t, token, nil)
	origBearerToken := bearerToken
	bearerToken = func() (string, error) { return token, nil }
	defer func() { bearerToken = origBearerToken }()

	client := testClient(api)
	rec := runInspectResourceRequest(t, client, "ns1", "~v1~Node", "node-1")

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
}

func TestInspectResourceHandlerRejectsClusterScopedSegmentForNamespacedKind(t *testing.T) {
	const token = "test-token"
	api := fakeAPIServer(t, token, nil)
	origBearerToken := bearerToken
	bearerToken = func() (string, error) { return token, nil }
	defer func() { bearerToken = origBearerToken }()

	client := testClient(api)
	rec := runInspectResourceRequest(t, client, clusterScopedSegment, "~v1~Service", "web")

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
