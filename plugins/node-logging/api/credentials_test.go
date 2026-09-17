package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestUseServiceAccountToken(t *testing.T) {
	for value, want := range map[string]bool{
		"true":  true,
		"TRUE":  true,
		" true": true,
		"false": false,
		"1":     false,
		"":      false,
	} {
		t.Setenv("USE_SERVICE_ACCOUNT_TOKEN", value)
		if got := useServiceAccountToken(); got != want {
			t.Errorf("useServiceAccountToken() with %q = %t, want %t", value, got, want)
		}
	}
}

func TestApplyForwardedCredentials(t *testing.T) {
	in := httptest.NewRequest(http.MethodGet, "/v1/nodes/node-1/journal", nil)
	in.Header.Set("Authorization", "Bearer user-token")
	in.Header.Set("Impersonate-User", "alice")
	in.Header["Impersonate-Group"] = []string{"developers", "system:authenticated"}
	in.Header.Set("Impersonate-Extra-Scopes", "user:full")
	in.Header.Set("Cookie", "openshift-session=secret")
	in.Header.Set("X-Forwarded-For", "10.0.0.1")

	out := httptest.NewRequest(http.MethodPost, "https://kubernetes.default.svc"+accessReviewPath, nil)
	if err := applyForwardedCredentials(out, in); err != nil {
		t.Fatalf("applyForwardedCredentials: %v", err)
	}

	if got := out.Header.Get("Authorization"); got != "Bearer user-token" {
		t.Errorf("Authorization = %q, want the caller's own token", got)
	}
	if got := out.Header.Get("Impersonate-User"); got != "alice" {
		t.Errorf("Impersonate-User = %q, want %q", got, "alice")
	}
	// Multi-valued impersonation headers (a user is in several groups) must
	// arrive whole, not collapsed to the first value.
	if got := out.Header.Values("Impersonate-Group"); len(got) != 2 {
		t.Errorf("Impersonate-Group = %q, want both groups", got)
	}
	if got := out.Header.Get("Impersonate-Extra-Scopes"); got != "user:full" {
		t.Errorf("Impersonate-Extra-Scopes = %q, want %q", got, "user:full")
	}
	for _, header := range []string{"Cookie", "X-Forwarded-For"} {
		if got := out.Header.Get(header); got != "" {
			t.Errorf("forwarded unrelated header %s = %q, want none", header, got)
		}
	}
}

func TestApplyForwardedCredentialsWithoutAuthorization(t *testing.T) {
	in := httptest.NewRequest(http.MethodGet, "/v1/nodes/node-1/journal", nil)
	// An Impersonate-* header on its own is never enough: it would otherwise
	// be paired with this plugin's own token further down.
	in.Header.Set("Impersonate-User", "system:admin")

	out := httptest.NewRequest(http.MethodPost, "https://kubernetes.default.svc"+accessReviewPath, nil)
	err := applyForwardedCredentials(out, in)
	if !errors.Is(err, errNoCredentials) {
		t.Fatalf("applyForwardedCredentials error = %v, want errNoCredentials", err)
	}
	if got := out.Header.Get("Impersonate-User"); got != "" {
		t.Errorf("Impersonate-User = %q, want nothing copied onto a request that has no credentials", got)
	}
}

func TestAuthorizeNodeLogsReportsApiServerRejection(t *testing.T) {
	t.Setenv("USE_SERVICE_ACCOUNT_TOKEN", "false")
	apiServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"kind":"Status","code":401}`, http.StatusUnauthorized)
	}))
	t.Cleanup(apiServer.Close)
	stubK8sAPI(apiServer)

	in := httptest.NewRequest(http.MethodGet, "/v1/nodes/node-1/journal", nil)
	in.Header.Set("Authorization", "Bearer expired-token")
	status, err := authorizeNodeLogs(in, "node-1")
	if err == nil {
		t.Fatal("authorizeNodeLogs succeeded, want an error for credentials the API server rejected")
	}
	if status != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401 passed through from the API server", status)
	}
}
