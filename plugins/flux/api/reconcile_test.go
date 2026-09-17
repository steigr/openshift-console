package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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
	path   string
	header http.Header
	body   map[string]interface{}
}

func newPatchRecordingServer(t *testing.T, getResponses map[string]interface{}) *patchRecordingServer {
	t.Helper()

	// Only reached in USE_SERVICE_ACCOUNT_TOKEN mode (see credentials.go);
	// stubbed regardless so no test can fall through to a real
	// ServiceAccount mount.
	origBearerToken := bearerToken
	bearerToken = func() (string, error) { return "sa-token", nil }
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
			rec.patches = append(rec.patches, recordedPatch{path: r.URL.Path, header: r.Header.Clone(), body: body})
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

// headers returns the headers the API server saw on the first recorded PATCH,
// whatever its path - enough for the credential tests, which only ever
// trigger one.
func (rec *patchRecordingServer) headers() http.Header {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.patches) == 0 {
		return nil
	}
	return rec.patches[0].header
}

func reconcileTestClient(srv *httptest.Server) *k8sClient {
	return &k8sClient{baseURL: srv.URL, http: srv.Client()}
}

// newReconcileRequest builds the request console's plugin proxy would deliver
// for a reconcile: a POST of the target as JSON, with the logged-in user's
// Authorization header on it (without which the handler answers 401 - see
// credentials.go).
func newReconcileRequest(t *testing.T, target reconcileTarget) *http.Request {
	t.Helper()
	body, err := json.Marshal(target)
	if err != nil {
		t.Fatalf("marshal target: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/reconcile", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer user-token")
	return req
}

func TestReconcileHandlerRejectsNonPost(t *testing.T) {
	rec := newPatchRecordingServer(t, nil)
	req := httptest.NewRequest(http.MethodGet, "/v1/reconcile", nil)
	w := httptest.NewRecorder()
	reconcileHandlerWithClient(w, req, reconcileTestClient(rec.Server))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusMethodNotAllowed)
	}
	if allow := w.Header().Get("Allow"); allow != http.MethodPost {
		t.Fatalf("Allow = %q, want %q", allow, http.MethodPost)
	}
}

func TestReconcileHandlerRejectsMalformedBody(t *testing.T) {
	rec := newPatchRecordingServer(t, nil)
	req := httptest.NewRequest(http.MethodPost, "/v1/reconcile", strings.NewReader("not json"))
	req.Header.Set("Authorization", "Bearer user-token")
	w := httptest.NewRecorder()
	reconcileHandlerWithClient(w, req, reconcileTestClient(rec.Server))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}

func TestReconcileHandlerRejectsUnknownKind(t *testing.T) {
	rec := newPatchRecordingServer(t, nil)
	req := newReconcileRequest(t, reconcileTarget{
		Group: "notification.toolkit.fluxcd.io", Version: "v1beta3", Kind: "Alert",
		Namespace: "flux-system", Name: "main",
	})
	w := httptest.NewRecorder()
	reconcileHandlerWithClient(w, req, reconcileTestClient(rec.Server))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", w.Code, http.StatusBadRequest, w.Body.String())
	}
}

func TestReconcileHandlerPatchesRequestedAtAnnotation(t *testing.T) {
	rec := newPatchRecordingServer(t, nil)
	req := newReconcileRequest(t, reconcileTarget{
		Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Kind: "Kustomization",
		Namespace: "flux-system", Name: "apps",
	})
	w := httptest.NewRecorder()
	reconcileHandlerWithClient(w, req, reconcileTestClient(rec.Server))
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
	req := newReconcileRequest(t, reconcileTarget{
		Group: "helm.toolkit.fluxcd.io", Version: "v2", Kind: "HelmRelease",
		Namespace: "flux-system", Name: "podinfo", Force: true, Reset: true,
	})
	w := httptest.NewRecorder()
	reconcileHandlerWithClient(w, req, reconcileTestClient(rec.Server))
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
	req := newReconcileRequest(t, reconcileTarget{
		Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Kind: "Kustomization",
		Namespace: "flux-system", Name: "apps", WithSource: true,
	})
	w := httptest.NewRecorder()
	reconcileHandlerWithClient(w, req, reconcileTestClient(rec.Server))
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
	req := newReconcileRequest(t, reconcileTarget{
		Group: "helm.toolkit.fluxcd.io", Version: "v2", Kind: "HelmRelease",
		Namespace: "flux-system", Name: "podinfo", WithSource: true,
	})
	w := httptest.NewRecorder()
	reconcileHandlerWithClient(w, req, reconcileTestClient(rec.Server))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	// helm-controller materializes a HelmChart named "<release-namespace>-<release-name>".
	helmChartAnnotations := rec.annotations("/apis/source.toolkit.fluxcd.io/v1/namespaces/flux-system/helmcharts/flux-system-podinfo")
	if helmChartAnnotations == nil {
		t.Fatalf("no patch recorded for the generated HelmChart")
	}
}
