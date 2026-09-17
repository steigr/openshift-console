package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// newInboundRequest stands in for the request console's plugin proxy delivers:
// the logged-in user's Authorization header, plus the Impersonate-* headers
// console adds when it authenticates as its own service account
// (--plugin-impersonation), and an unrelated header that must not travel on.
func newInboundRequest() *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/v1/reconcile", nil)
	req.Header.Set("Authorization", "Bearer user-token")
	req.Header.Set("Impersonate-User", "alice")
	req.Header.Add("Impersonate-Group", "system:authenticated")
	req.Header.Add("Impersonate-Group", "dev")
	req.Header.Set("Cookie", "openshift-session-token=secret")
	return req
}

// newOutgoingRequest is the API server request k8sClient.do builds, before
// applyCredentials gets to it: no headers of its own yet.
func newOutgoingRequest(t *testing.T) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodPatch, "https://kube-apiserver/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/flux-system/kustomizations/apps", nil)
	if err != nil {
		t.Fatalf("build outgoing request: %v", err)
	}
	return req
}

func TestApplyCredentialsForwardsUserTokenAndImpersonation(t *testing.T) {
	out := newOutgoingRequest(t)

	if err := applyCredentials(out, newInboundRequest()); err != nil {
		t.Fatalf("applyCredentials: %v", err)
	}

	if got := out.Header.Get("Authorization"); got != "Bearer user-token" {
		t.Fatalf("Authorization = %q, want the forwarded user token", got)
	}
	if got := out.Header.Get("Impersonate-User"); got != "alice" {
		t.Fatalf("Impersonate-User = %q, want alice", got)
	}
	if got := out.Header.Values("Impersonate-Group"); len(got) != 2 || got[0] != "system:authenticated" || got[1] != "dev" {
		t.Fatalf("Impersonate-Group = %v, want both forwarded values", got)
	}
	// Only the credentials travel: the API server has no use for console's
	// session cookie, and forwarding it would leak it to every backend.
	if got := out.Header.Get("Cookie"); got != "" {
		t.Fatalf("Cookie = %q, want it not forwarded", got)
	}
}

func TestApplyCredentialsWithoutAuthorization(t *testing.T) {
	in := httptest.NewRequest(http.MethodPost, "/v1/reconcile", nil)

	err := applyCredentials(newOutgoingRequest(t), in)
	if !errors.Is(err, errNoCredentials) {
		t.Fatalf("err = %v, want errNoCredentials", err)
	}
}

// A request that didn't arrive through an authorized plugin proxy route can't
// be attributed to anyone, so the handler rejects it rather than falling back
// to this pod's own token.
func TestReconcileHandlerWithoutCredentials(t *testing.T) {
	rec := newPatchRecordingServer(t, nil)
	req := newReconcileRequest(t, reconcileTarget{
		Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Kind: "Kustomization",
		Namespace: "flux-system", Name: "apps",
	})
	req.Header.Del("Authorization")
	w := httptest.NewRecorder()
	reconcileHandlerWithClient(w, req, reconcileTestClient(rec.Server))

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d; body: %s", w.Code, http.StatusUnauthorized, w.Body.String())
	}
	if rec.headers() != nil {
		t.Fatalf("a PATCH reached the API server despite the missing credentials")
	}
}

// End-to-end through the handler: the reconcile PATCH kube-apiserver sees
// carries the caller's own credentials, which is what makes it authorized as
// the user who clicked Reconcile rather than as this plugin.
func TestReconcileHandlerPatchesAsTheForwardedUser(t *testing.T) {
	rec := newPatchRecordingServer(t, nil)
	req := newReconcileRequest(t, reconcileTarget{
		Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Kind: "Kustomization",
		Namespace: "flux-system", Name: "apps",
	})
	req.Header.Set("Impersonate-User", "alice")
	w := httptest.NewRecorder()
	reconcileHandlerWithClient(w, req, reconcileTestClient(rec.Server))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	header := rec.headers()
	if header == nil {
		t.Fatalf("no PATCH recorded")
	}
	if got := header.Get("Authorization"); got != "Bearer user-token" {
		t.Fatalf("Authorization = %q, want the forwarded user token", got)
	}
	if got := header.Get("Impersonate-User"); got != "alice" {
		t.Fatalf("Impersonate-User = %q, want alice", got)
	}
}

// With USE_SERVICE_ACCOUNT_TOKEN the backend is back to acting as itself, and
// must then ignore forwarded impersonation entirely: its ServiceAccount may
// well be allowed to impersonate, so honouring a caller-supplied
// Impersonate-* header would let anyone reaching this backend act as anyone.
func TestReconcileHandlerUsesServiceAccountTokenWhenConfigured(t *testing.T) {
	t.Setenv("USE_SERVICE_ACCOUNT_TOKEN", "true")

	rec := newPatchRecordingServer(t, nil)
	req := newReconcileRequest(t, reconcileTarget{
		Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Kind: "Kustomization",
		Namespace: "flux-system", Name: "apps",
	})
	req.Header.Set("Impersonate-User", "alice")
	w := httptest.NewRecorder()
	reconcileHandlerWithClient(w, req, reconcileTestClient(rec.Server))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	header := rec.headers()
	if header == nil {
		t.Fatalf("no PATCH recorded")
	}
	if got := header.Get("Authorization"); got != "Bearer sa-token" {
		t.Fatalf("Authorization = %q, want this pod's own mounted token", got)
	}
	if got := header.Get("Impersonate-User"); got != "" {
		t.Fatalf("Impersonate-User = %q, want the forwarded impersonation dropped", got)
	}
}

// Without an Authorization header of its own, a request in
// USE_SERVICE_ACCOUNT_TOKEN mode still succeeds - the mounted token is the
// only credential that mode ever uses.
func TestReconcileHandlerServiceAccountTokenNeedsNoForwardedCredentials(t *testing.T) {
	t.Setenv("USE_SERVICE_ACCOUNT_TOKEN", "true")

	rec := newPatchRecordingServer(t, nil)
	req := newReconcileRequest(t, reconcileTarget{
		Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Kind: "Kustomization",
		Namespace: "flux-system", Name: "apps",
	})
	req.Header.Del("Authorization")
	w := httptest.NewRecorder()
	reconcileHandlerWithClient(w, req, reconcileTestClient(rec.Server))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
}

// A mounted token that can't be read is this deployment's own
// misconfiguration, not the caller's: 500, not 401.
func TestReconcileHandlerUnreadableServiceAccountToken(t *testing.T) {
	t.Setenv("USE_SERVICE_ACCOUNT_TOKEN", "true")

	rec := newPatchRecordingServer(t, nil)
	bearerToken = func() (string, error) { return "", errors.New("reading service account token: no such file") }

	req := newReconcileRequest(t, reconcileTarget{
		Group: "kustomize.toolkit.fluxcd.io", Version: "v1", Kind: "Kustomization",
		Namespace: "flux-system", Name: "apps",
	})
	w := httptest.NewRecorder()
	reconcileHandlerWithClient(w, req, reconcileTestClient(rec.Server))

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d; body: %s", w.Code, http.StatusInternalServerError, w.Body.String())
	}
}
