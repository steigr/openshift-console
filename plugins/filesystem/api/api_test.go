package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeAPIServer points the package's API server client at a stub. k8sOnce is
// marked done first so the real in-cluster initialisation never runs.
func fakeAPIServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	k8sOnce.Do(func() {})
	k8sInitErr = nil
	k8sBase = server.URL
	k8sClient = server.Client()
	return server
}

func callerHeader() http.Header {
	header := http.Header{}
	header.Set("Authorization", "Bearer user-token")
	header.Set("Impersonate-User", "alice")
	header.Set("Impersonate-Group", "dev")
	return header
}

func TestApplyForwardedCredentialsPassesImpersonationThrough(t *testing.T) {
	out := http.Header{}
	if err := applyForwardedCredentials(out, callerHeader()); err != nil {
		t.Fatal(err)
	}
	if out.Get("Authorization") != "Bearer user-token" {
		t.Errorf("Authorization = %q", out.Get("Authorization"))
	}
	if out.Get("Impersonate-User") != "alice" || out.Get("Impersonate-Group") != "dev" {
		t.Errorf("impersonation headers were not carried over: %v", out)
	}
	if out.Get("Cookie") != "" {
		t.Error("only credentials should be copied")
	}
}

func TestApplyForwardedCredentialsRefusesAnonymous(t *testing.T) {
	if err := applyForwardedCredentials(http.Header{}, http.Header{}); err == nil {
		t.Fatal("a request with no forwarded credentials must be refused, never served on the plugin's own token")
	}
}

func TestAuthorizeContainerAccessAsksAboutPodsExec(t *testing.T) {
	var got accessReview
	fakeAPIServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != accessReviewPath {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer user-token" {
			t.Errorf("the review must be sent as the caller, got %q", r.Header.Get("Authorization"))
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": map[string]any{"allowed": true}})
	})

	if err := authorizeContainerAccess(context.Background(), callerHeader(), "team-a", "web-0"); err != nil {
		t.Fatal(err)
	}

	attrs := got.Spec.ResourceAttributes
	if attrs.Resource != "pods" || attrs.Subresource != "exec" || attrs.Verb != "create" {
		t.Errorf("review asked about %+v, want create pods/exec", attrs)
	}
	if attrs.Namespace != "team-a" || attrs.Name != "web-0" {
		t.Errorf("review was not scoped to the pod: %+v", attrs)
	}
}

func TestAuthorizeContainerAccessDenies(t *testing.T) {
	fakeAPIServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": map[string]any{"allowed": false, "reason": "no RoleBinding"},
		})
	})

	err := authorizeContainerAccess(context.Background(), callerHeader(), "team-a", "web-0")
	if err == nil {
		t.Fatal("a denied review must fail the request")
	}
	if connectStatus(err) != http.StatusForbidden {
		t.Errorf("status = %d, want 403", connectStatus(err))
	}
	if !strings.Contains(err.Error(), "pods/exec") {
		t.Errorf("the error should say what permission is missing, got %q", err)
	}
}

func connectStatus(err error) int {
	var status *apiStatusError
	if errors.As(err, &status) {
		return status.Status()
	}
	return 0
}

const podJSON = `{
  "metadata": {"uid": "pod-uid-1", "annotations": {"kubectl.kubernetes.io/default-container": "app"}},
  "spec": {"nodeName": "node-1", "containers": [{"name": "sidecar"}, {"name": "app"}]},
  "status": {
    "phase": "Running",
    "containerStatuses": [
      {"name": "sidecar", "containerID": "containerd://1111", "state": {"running": {}}},
      {"name": "app", "containerID": "containerd://2222", "state": {"running": {}}}
    ]
  }
}`

func TestResolvePodHonoursTheDefaultContainerAnnotation(t *testing.T) {
	fakeAPIServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer user-token" {
			t.Errorf("the pod must be read as the caller, not as this plugin")
		}
		_, _ = w.Write([]byte(podJSON))
	})

	target, err := resolvePod(context.Background(), callerHeader(), "team-a", "web-0", "")
	if err != nil {
		t.Fatal(err)
	}
	if target.Container != "app" || target.ContainerID != "containerd://2222" {
		t.Errorf("resolved %+v, want the annotated default container", target)
	}
	if target.Node != "node-1" {
		t.Errorf("resolved %+v", target)
	}
}

func TestResolvePodNamesAnUnknownContainer(t *testing.T) {
	fakeAPIServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(podJSON))
	})

	if _, err := resolvePod(context.Background(), callerHeader(), "team-a", "web-0", "nope"); err == nil {
		t.Fatal("asking for a container the pod does not have must fail")
	}
}

func TestResolvePodValidatesNames(t *testing.T) {
	// No API server is stood up: these must be refused before any request.
	for _, tc := range []struct{ ns, pod, container string }{
		{"../etc", "web-0", ""},
		{"team-a", "web 0", ""},
		{"team-a", "web-0", "bad/name"},
	} {
		if _, err := resolvePod(context.Background(), callerHeader(), tc.ns, tc.pod, tc.container); err == nil {
			t.Errorf("resolvePod(%q,%q,%q) should have been refused", tc.ns, tc.pod, tc.container)
		}
	}
}

func TestLookupAgentUsesThePluginsOwnToken(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "token"), []byte("sa-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	original := serviceAccountDir
	serviceAccountDir = dir
	t.Cleanup(func() { serviceAccountDir = original })
	t.Setenv("POD_NAMESPACE", "console")

	fakeAPIServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sa-token" {
			t.Errorf("the agent lookup must use the plugin's own token, got %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("Impersonate-User") != "" {
			t.Error("the plugin's own token must never be paired with caller-supplied impersonation")
		}
		if got := r.URL.Query().Get("fieldSelector"); !strings.Contains(got, "spec.nodeName=node-1") {
			t.Errorf("fieldSelector = %q", got)
		}
		_, _ = w.Write([]byte(`{"items":[{"metadata":{"name":"agent-x"},"status":{"podIP":"10.1.2.3"}}]}`))
	})

	ip, err := lookupAgent(context.Background(), "node-1")
	if err != nil {
		t.Fatal(err)
	}
	if ip != "10.1.2.3" {
		t.Errorf("ip = %q", ip)
	}
}

func TestPluginConfigDefaults(t *testing.T) {
	cfg := loadPluginConfig()
	if !cfg.PodFileBrowserEnabled {
		t.Error("the Files tab ships on: unlike the terminal and logging plugins this one replaces no console tab")
	}
	if cfg.UploadChunkBytes <= 0 || cfg.ViewMaxBytes <= 0 {
		t.Errorf("config = %+v", cfg)
	}

	t.Setenv("POD_FILE_BROWSER_ENABLED", "false")
	t.Setenv("UPLOAD_CHUNK_BYTES", "1024")
	cfg = loadPluginConfig()
	if cfg.PodFileBrowserEnabled || cfg.UploadChunkBytes != 1024 {
		t.Errorf("config = %+v", cfg)
	}
}

func TestConfigPathsCoverBothAssetLayouts(t *testing.T) {
	paths := configPaths()
	if len(paths) == 0 || paths[0] != "/config.json" {
		t.Fatalf("paths = %v", paths)
	}
}

func TestUseServiceAccountTokenIsOffByDefault(t *testing.T) {
	if useServiceAccountToken() {
		t.Fatal("skipping the caller's own permission check must be opt-in")
	}
	t.Setenv("USE_SERVICE_ACCOUNT_TOKEN", "true")
	if !useServiceAccountToken() {
		t.Fatal("USE_SERVICE_ACCOUNT_TOKEN=true should turn it on")
	}
}
