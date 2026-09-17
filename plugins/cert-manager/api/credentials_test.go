package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// recordingAPIServer stands in for kube-apiserver and keeps the headers of
// the last request it saw, so a test can assert what credentials the
// outgoing call actually carried rather than only that it succeeded.
func recordingAPIServer(t *testing.T) (*httptest.Server, *http.Header) {
	t.Helper()
	var seen http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"metadata":{"name":"web","namespace":"ns1"}}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &seen
}

// stubBearerToken points the mounted-token reader at a fixed value for one
// test, so the USE_SERVICE_ACCOUNT_TOKEN path works with no real
// ServiceAccount mount present.
func stubBearerToken(t *testing.T, token string, err error) {
	t.Helper()
	original := bearerToken
	bearerToken = func() (string, error) { return token, err }
	t.Cleanup(func() { bearerToken = original })
}

// TestForwardedCredentialsReachTheAPIServer is the whole point of the
// default mode: the API call is made as the caller, including whatever
// impersonation console applied, so the read is authorized against them and
// not against this pod's ServiceAccount.
func TestForwardedCredentialsReachTheAPIServer(t *testing.T) {
	srv, seen := recordingAPIServer(t)
	client := testClient(srv)

	// A token this plugin could never produce itself, so a pass would be
	// impossible if the mounted token were used by mistake.
	stubBearerToken(t, "service-account-token", nil)

	in := httptest.NewRequest(http.MethodGet, "/v1/inspect/ns/ns1/~v1~Service/web", nil)
	in.Header.Set("Authorization", "Bearer user-token")
	in.Header.Set("Impersonate-User", "alice")
	in.Header.Add("Impersonate-Group", "system:authenticated")
	in.Header.Add("Impersonate-Group", "dev")
	in.Header.Set("Cookie", "openshift-session=secret")

	var obj unstructuredObject
	if err := client.do(in.Context(), in, "/api/v1/namespaces/ns1/services/web", &obj); err != nil {
		t.Fatalf("do: %v", err)
	}

	if got := seen.Get("Authorization"); got != "Bearer user-token" {
		t.Fatalf("Authorization = %q, want the forwarded user token", got)
	}
	if got := seen.Get("Impersonate-User"); got != "alice" {
		t.Fatalf("Impersonate-User = %q, want %q", got, "alice")
	}
	if got := seen.Values("Impersonate-Group"); len(got) != 2 || got[0] != "system:authenticated" || got[1] != "dev" {
		t.Fatalf("Impersonate-Group = %v, want both values forwarded", got)
	}
	// Only credentials travel: nothing else from the inbound request is
	// replayed at the API server.
	if got := seen.Get("Cookie"); got != "" {
		t.Fatalf("Cookie = %q, want it left behind", got)
	}
}

// TestNoForwardedCredentialsIs401 covers a request that did not come through
// a plugin proxy route configured to authorize: nothing is sent upstream, and
// the caller is told to authenticate rather than shown a backend error.
func TestNoForwardedCredentialsIs401(t *testing.T) {
	srv, seen := recordingAPIServer(t)
	client := testClient(srv)
	stubBearerToken(t, "service-account-token", nil)

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/inspect/ns/{namespace}/{gvk}/{name}", func(w http.ResponseWriter, r *http.Request) {
		inspectResourceHandlerWithClient(w, r, client)
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/inspect/ns/ns1/~v1~Service/web", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401: %s", rec.Code, rec.Body.String())
	}
	if *seen != nil {
		t.Fatal("the API server was called although no credentials arrived")
	}
}

// TestServiceAccountTokenModeIgnoresForwardedHeaders covers the opt-in
// (chart value useServiceAccountToken): this plugin's own token is used, and
// caller-supplied impersonation must not ride along with it - the
// ServiceAccount may be allowed to impersonate anyone, so honouring those
// headers here would let a caller borrow an identity the API server would
// never have granted their own token.
func TestServiceAccountTokenModeIgnoresForwardedHeaders(t *testing.T) {
	t.Setenv("USE_SERVICE_ACCOUNT_TOKEN", "true")

	srv, seen := recordingAPIServer(t)
	client := testClient(srv)
	stubBearerToken(t, "service-account-token", nil)

	in := httptest.NewRequest(http.MethodGet, "/v1/inspect/ns/ns1/~v1~Service/web", nil)
	in.Header.Set("Authorization", "Bearer user-token")
	in.Header.Set("Impersonate-User", "system:admin")

	var obj unstructuredObject
	if err := client.do(in.Context(), in, "/api/v1/namespaces/ns1/services/web", &obj); err != nil {
		t.Fatalf("do: %v", err)
	}

	if got := seen.Get("Authorization"); got != "Bearer service-account-token" {
		t.Fatalf("Authorization = %q, want this pod's own mounted token", got)
	}
	if got := seen.Get("Impersonate-User"); got != "" {
		t.Fatalf("Impersonate-User = %q, want it dropped in service-account-token mode", got)
	}
}

// TestServiceAccountTokenModeWithoutAMountIs500 covers the remaining
// credential failure: USE_SERVICE_ACCOUNT_TOKEN is set but no token is
// mounted. That is this backend's own misconfiguration, not the caller's, so
// it is a 500 and not a 401 or a 502.
func TestServiceAccountTokenModeWithoutAMountIs500(t *testing.T) {
	t.Setenv("USE_SERVICE_ACCOUNT_TOKEN", "true")

	srv, _ := recordingAPIServer(t)
	client := testClient(srv)
	stubBearerToken(t, "", errors.New("reading service account token: no such file"))

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/inspect/ns/{namespace}/{gvk}/{name}", func(w http.ResponseWriter, r *http.Request) {
		inspectResourceHandlerWithClient(w, r, client)
	})

	req := httptest.NewRequest(http.MethodGet, "/v1/inspect/ns/ns1/~v1~Service/web", nil)
	req.Header.Set("Authorization", "Bearer user-token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500: %s", rec.Code, rec.Body.String())
	}
}

func TestUseServiceAccountTokenParsesTheEnvVar(t *testing.T) {
	cases := map[string]bool{"": false, "false": false, "TRUE": true, " true ": true, "1": false}
	for value, want := range cases {
		t.Setenv("USE_SERVICE_ACCOUNT_TOKEN", value)
		if got := useServiceAccountToken(); got != want {
			t.Errorf("USE_SERVICE_ACCOUNT_TOKEN=%q: got %v, want %v", value, got, want)
		}
	}
}
