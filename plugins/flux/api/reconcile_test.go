package api

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// patchRecordingServer stands in for kube-apiserver: it serves canned GET
// responses for exact paths and records every PATCH's path+body, so tests
// can assert exactly which objects were annotated without a real cluster.
type patchRecordingServer struct {
	*httptest.Server
	mu      sync.Mutex
	patches []recordedPatch
}

type recordedPatch struct {
	path string
	body map[string]interface{}
}

func newPatchRecordingServer(t *testing.T, getResponses map[string]interface{}) *patchRecordingServer {
	t.Helper()

	origBearerToken := bearerToken
	bearerToken = func() (string, error) { return "test-token", nil }
	t.Cleanup(func() { bearerToken = origBearerToken })

	rec := &patchRecordingServer{}
	rec.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			body, ok := getResponses[r.URL.Path]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				_ = json.NewEncoder(w).Encode(map[string]string{"message": "not found: " + r.URL.Path})
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(body)
		case http.MethodPatch:
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			rec.mu.Lock()
			rec.patches = append(rec.patches, recordedPatch{path: r.URL.Path, body: body})
			rec.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(rec.Server.Close)
	return rec
}

func (rec *patchRecordingServer) annotations(path string) map[string]interface{} {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	for _, p := range rec.patches {
		if p.path == path {
			metadata, _ := p.body["metadata"].(map[string]interface{})
			annotations, _ := metadata["annotations"].(map[string]interface{})
			return annotations
		}
	}
	return nil
}

func reconcileTestClient(srv *httptest.Server) *k8sClient {
	return &k8sClient{baseURL: srv.URL, http: srv.Client()}
}

func encodeReconcilePayload(t *testing.T, target reconcileTarget) string {
	t.Helper()
	raw, err := json.Marshal(target)
	if err != nil {
		t.Fatalf("marshal target: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func TestReconcileHandlerRejectsNonGet(t *testing.T) {
	rec := newPatchRecordingServer(t, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/reconcile/anything", nil)
	w := httptest.NewRecorder()
	reconcileHandlerWithClient(w, req, reconcileTestClient(rec.Server))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusMethodNotAllowed)
	}
}

func TestReconcileHandlerRejectsUnknownKind(t *testing.T) {
	rec := newPatchRecordingServer(t, nil)
	payload := encodeReconcilePayload(t, reconcileTarget{
		Group: "notification.toolkit.fluxcd.io", Version: "v1beta3", Kind: "Alert",
		Namespace: "flux-system", Name: "main",
	})
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/reconcile/{payload}", func(w http.ResponseWriter, r *http.Request) {
		reconcileHandlerWithClient(w, r, reconcileTestClient(rec.Server))
	})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/reconcile/"+payload, nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}

func TestReconcileHandlerPatchesRequestedAtAnnotation(t *testing.T) {
	rec := newPatchRecordingServer(t, nil)
	payload := encodeReconcilePayload(t, reconcileTarget{
		Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Kind: "Kustomization",
		Namespace: "flux-system", Name: "apps",
	})
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/reconcile/{payload}", func(w http.ResponseWriter, r *http.Request) {
		reconcileHandlerWithClient(w, r, reconcileTestClient(rec.Server))
	})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/reconcile/"+payload, nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	annotations := rec.annotations("/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/flux-system/kustomizations/apps")
	if annotations == nil {
		t.Fatalf("no patch recorded for the Kustomization")
	}
	if _, ok := annotations[reconcileRequestAnnotation]; !ok {
		t.Fatalf("annotations = %v, missing %q", annotations, reconcileRequestAnnotation)
	}

	var resp reconcileResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.RequestedAt == "" {
		t.Fatalf("response requestedAt is empty")
	}
}

func TestReconcileHandlerHelmReleaseForceAndReset(t *testing.T) {
	rec := newPatchRecordingServer(t, nil)
	payload := encodeReconcilePayload(t, reconcileTarget{
		Group: "helm.toolkit.fluxcd.io", Version: "v2", Kind: "HelmRelease",
		Namespace: "flux-system", Name: "podinfo", Force: true, Reset: true,
	})
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/reconcile/{payload}", func(w http.ResponseWriter, r *http.Request) {
		reconcileHandlerWithClient(w, r, reconcileTestClient(rec.Server))
	})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/reconcile/"+payload, nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	annotations := rec.annotations("/apis/helm.toolkit.fluxcd.io/v2/namespaces/flux-system/helmreleases/podinfo")
	if annotations == nil {
		t.Fatalf("no patch recorded for the HelmRelease")
	}
	for _, key := range []string{reconcileRequestAnnotation, helmReleaseForceRequestAnnotation, helmReleaseResetRequestAnnotation} {
		if _, ok := annotations[key]; !ok {
			t.Fatalf("annotations = %v, missing %q", annotations, key)
		}
	}
}

func TestReconcileHandlerWithSourceResolvesKustomizationSourceRef(t *testing.T) {
	kustomizationPath := "/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/flux-system/kustomizations/apps"
	rec := newPatchRecordingServer(t, map[string]interface{}{
		kustomizationPath: map[string]interface{}{
			"spec": map[string]interface{}{
				"sourceRef": map[string]interface{}{"kind": "GitRepository", "name": "rollout"},
			},
		},
	})
	payload := encodeReconcilePayload(t, reconcileTarget{
		Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Kind: "Kustomization",
		Namespace: "flux-system", Name: "apps", WithSource: true,
	})
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/reconcile/{payload}", func(w http.ResponseWriter, r *http.Request) {
		reconcileHandlerWithClient(w, r, reconcileTestClient(rec.Server))
	})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/reconcile/"+payload, nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	// sourceRef didn't specify a namespace, so it should default to the
	// Kustomization's own namespace (flux-system) - same as the CLI.
	gitRepoAnnotations := rec.annotations("/apis/source.toolkit.fluxcd.io/v1/namespaces/flux-system/gitrepositories/rollout")
	if gitRepoAnnotations == nil {
		t.Fatalf("no patch recorded for the GitRepository source")
	}
	kustomizationAnnotations := rec.annotations(kustomizationPath)
	if kustomizationAnnotations == nil {
		t.Fatalf("no patch recorded for the Kustomization itself")
	}

	var resp reconcileResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.SourceKind != "GitRepository" || resp.SourceName != "rollout" {
		t.Fatalf("resp = %+v, want SourceKind=GitRepository SourceName=rollout", resp)
	}
}

func TestReconcileHandlerWithSourceHelmReleaseChartTemplate(t *testing.T) {
	helmReleasePath := "/apis/helm.toolkit.fluxcd.io/v2/namespaces/flux-system/helmreleases/podinfo"
	rec := newPatchRecordingServer(t, map[string]interface{}{
		helmReleasePath: map[string]interface{}{
			"spec": map[string]interface{}{
				"chart": map[string]interface{}{
					"spec": map[string]interface{}{
						"sourceRef": map[string]interface{}{"kind": "HelmRepository", "name": "podinfo", "namespace": "flux-system"},
					},
				},
			},
		},
	})
	payload := encodeReconcilePayload(t, reconcileTarget{
		Group: "helm.toolkit.fluxcd.io", Version: "v2", Kind: "HelmRelease",
		Namespace: "flux-system", Name: "podinfo", WithSource: true,
	})
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/reconcile/{payload}", func(w http.ResponseWriter, r *http.Request) {
		reconcileHandlerWithClient(w, r, reconcileTestClient(rec.Server))
	})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/reconcile/"+payload, nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	// helm-controller materializes a HelmChart named "<release-namespace>-<release-name>".
	helmChartAnnotations := rec.annotations("/apis/source.toolkit.fluxcd.io/v1/namespaces/flux-system/helmcharts/flux-system-podinfo")
	if helmChartAnnotations == nil {
		t.Fatalf("no patch recorded for the generated HelmChart")
	}
}
