package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeCluster stands in for kube-apiserver plus the node-logs-api pod running
// on one node, and records what each of them was asked -- which is where the
// interesting assertions live: which credentials reached which of the two, and
// what query string survived the trip.
type fakeCluster struct {
	// allowed/reason are what the SelfSubjectAccessReview comes back with.
	allowed bool
	reason  string

	reviews       []accessReviewResource
	reviewHeaders []http.Header
	podListAuth   []string
	podListQuery  []url.Values
	journalQuery  []string
}

const journalBody = "-- Journal begins at Mon 2026-01-05 --\n"

func newFakeCluster(t *testing.T) *fakeCluster {
	t.Helper()
	cluster := &fakeCluster{allowed: true}

	nodeLogs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cluster.journalQuery = append(cluster.journalQuery, r.URL.RawQuery)
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte(journalBody))
	}))
	t.Cleanup(nodeLogs.Close)
	nodeLogsURL, err := url.Parse(nodeLogs.URL)
	if err != nil {
		t.Fatalf("parsing node-logs-api URL: %v", err)
	}

	apiMux := http.NewServeMux()
	apiMux.HandleFunc("POST "+accessReviewPath, func(w http.ResponseWriter, r *http.Request) {
		var review accessReview
		if err := json.NewDecoder(r.Body).Decode(&review); err != nil {
			t.Errorf("decoding access review: %v", err)
		}
		cluster.reviews = append(cluster.reviews, review.Spec.ResourceAttributes)
		cluster.reviewHeaders = append(cluster.reviewHeaders, r.Header.Clone())
		w.Header().Set("Content-Type", "application/json")
		// A real API server answers a review with 201 Created, since creating
		// one is how it is asked.
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": map[string]any{"allowed": cluster.allowed, "reason": cluster.reason},
		})
	})
	apiMux.HandleFunc("GET /api/v1/namespaces/{namespace}/pods", func(w http.ResponseWriter, r *http.Request) {
		cluster.podListAuth = append(cluster.podListAuth, r.Header.Get("Authorization"))
		cluster.podListQuery = append(cluster.podListQuery, r.URL.Query())
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []map[string]any{{
				"metadata": map[string]any{"name": "node-logs-api-2xkq7"},
				// The journal fetch goes straight to the pod IP, so pointing
				// it at the loopback address the node-logs stub listens on is
				// enough to exercise the whole path.
				"status": map[string]any{"phase": "Running", "podIP": nodeLogsURL.Hostname()},
			}},
		})
	})
	apiServer := httptest.NewServer(apiMux)
	t.Cleanup(apiServer.Close)
	stubK8sAPI(apiServer)

	// The ServiceAccount mount the pod lookup reads its own token and this
	// pod's namespace from.
	dir := t.TempDir()
	for name, content := range map[string]string{"token": "sa-token\n", "namespace": "openshift-console\n"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatalf("writing fake ServiceAccount %s: %v", name, err)
		}
	}
	previousDir := serviceAccountDir
	serviceAccountDir = dir
	t.Cleanup(func() { serviceAccountDir = previousDir })

	t.Setenv("NODE_LOGS_API_PORT", nodeLogsURL.Port())
	t.Setenv("USE_SERVICE_ACCOUNT_TOKEN", "false")
	return cluster
}

// stubK8sAPI points the lazily initialised API server client at srv, consuming
// the sync.Once so the in-cluster initialisation never runs.
func stubK8sAPI(srv *httptest.Server) {
	k8sOnce.Do(func() {})
	k8sInitErr = nil
	k8sBase = srv.URL
	k8sClient = srv.Client()
}

func serveJournal(target string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	mux := http.NewServeMux()
	RegisterHandlers(mux)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, req)
	return recorder
}

var userCredentials = map[string]string{"Authorization": "Bearer user-token"}

func TestJournalServesCallerAllowedToGetNodesProxy(t *testing.T) {
	cluster := newFakeCluster(t)

	recorder := serveJournal("/v1/nodes/node-1/journal?unit=kubelet&tailLines=1000", map[string]string{
		"Authorization":     "Bearer user-token",
		"Impersonate-User":  "alice",
		"Impersonate-Group": "system:authenticated",
		"Cookie":            "openshift-session=secret",
	})

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.String() != journalBody {
		t.Errorf("body = %q, want the node-logs-api response %q", recorder.Body.String(), journalBody)
	}
	// The query string reaches the DaemonSet exactly as the caller sent it,
	// which is the whole point of serving this on the plugin proxy route.
	if len(cluster.journalQuery) != 1 || cluster.journalQuery[0] != "unit=kubelet&tailLines=1000" {
		t.Errorf("node-logs-api queries = %q, want [\"unit=kubelet&tailLines=1000\"]", cluster.journalQuery)
	}

	if len(cluster.reviews) != 1 {
		t.Fatalf("access reviews = %d, want exactly 1", len(cluster.reviews))
	}
	want := accessReviewResource{Resource: "nodes", Subresource: "proxy", Verb: "get", Name: "node-1"}
	if cluster.reviews[0] != want {
		t.Errorf("access review asked about %+v, want %+v", cluster.reviews[0], want)
	}
	// The review runs as the caller: their token and impersonation headers,
	// and nothing else off the inbound request.
	header := cluster.reviewHeaders[0]
	if got := header.Get("Authorization"); got != "Bearer user-token" {
		t.Errorf("access review Authorization = %q, want the caller's own token", got)
	}
	if got := header.Get("Impersonate-User"); got != "alice" {
		t.Errorf("access review Impersonate-User = %q, want %q", got, "alice")
	}
	if got := header.Get("Impersonate-Group"); got != "system:authenticated" {
		t.Errorf("access review Impersonate-Group = %q, want %q", got, "system:authenticated")
	}
	if got := header.Get("Cookie"); got != "" {
		t.Errorf("access review forwarded unrelated header Cookie = %q, want none", got)
	}

	// The pod lookup runs as the plugin itself, never as the caller, and
	// never with the caller's impersonation headers attached.
	if len(cluster.podListAuth) != 1 || cluster.podListAuth[0] != "Bearer sa-token" {
		t.Errorf("pod lookup Authorization = %q, want the plugin's own ServiceAccount token", cluster.podListAuth)
	}
	if got := cluster.podListQuery[0].Get("fieldSelector"); !strings.Contains(got, "spec.nodeName=node-1") {
		t.Errorf("pod lookup fieldSelector = %q, want it scoped to node-1", got)
	}
}

func TestJournalRawForcesUnlimitedTail(t *testing.T) {
	cluster := newFakeCluster(t)

	recorder := serveJournal("/v1/nodes/node-1/journal/raw?unit=kubelet&tailLines=1000", userCredentials)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", recorder.Code, recorder.Body.String())
	}
	if len(cluster.journalQuery) != 1 || cluster.journalQuery[0] != "tailLines=0&unit=kubelet" {
		t.Errorf("node-logs-api queries = %q, want [\"tailLines=0&unit=kubelet\"]", cluster.journalQuery)
	}
}

func TestJournalDeniedCallerGets403AndNoLogs(t *testing.T) {
	cluster := newFakeCluster(t)
	cluster.allowed = false
	cluster.reason = "no RBAC policy matched"

	recorder := serveJournal("/v1/nodes/node-1/journal?unit=kubelet", userCredentials)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %q)", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "nodes/proxy") {
		t.Errorf("body = %q, want it to name the missing permission", recorder.Body.String())
	}
	if len(cluster.journalQuery) != 0 {
		t.Errorf("node-logs-api was asked for %q, want nothing fetched for a denied caller", cluster.journalQuery)
	}
	// Denied callers learn nothing about the cluster, not even whether a
	// node-logs-api pod exists for that node.
	if len(cluster.podListAuth) != 0 {
		t.Errorf("pod lookups = %d, want none before the caller is authorized", len(cluster.podListAuth))
	}
}

func TestJournalWithoutForwardedCredentialsGets401(t *testing.T) {
	cluster := newFakeCluster(t)

	recorder := serveJournal("/v1/nodes/node-1/journal?unit=kubelet", nil)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (body %q)", recorder.Code, recorder.Body.String())
	}
	if len(cluster.reviews) != 0 {
		t.Errorf("access reviews = %d, want none without credentials to review", len(cluster.reviews))
	}
	if len(cluster.journalQuery) != 0 {
		t.Errorf("node-logs-api was asked for %q, want nothing fetched", cluster.journalQuery)
	}
}

func TestJournalWithServiceAccountTokenSkipsAccessReview(t *testing.T) {
	cluster := newFakeCluster(t)
	t.Setenv("USE_SERVICE_ACCOUNT_TOKEN", "true")

	// No Authorization header at all: in this mode the caller's permissions
	// are not consulted, so there is nothing to forward and nothing to check.
	recorder := serveJournal("/v1/nodes/node-1/journal?unit=kubelet", nil)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", recorder.Code, recorder.Body.String())
	}
	if len(cluster.reviews) != 0 {
		t.Errorf("access reviews = %d, want none with USE_SERVICE_ACCOUNT_TOKEN=true", len(cluster.reviews))
	}
	if len(cluster.journalQuery) != 1 || cluster.journalQuery[0] != "unit=kubelet" {
		t.Errorf("node-logs-api queries = %q, want [\"unit=kubelet\"]", cluster.journalQuery)
	}
}

// The journal query used to travel in an X-Node-Logs-Query header, because the
// plugin asset route drops query strings. On the proxy route it does not, and
// the header is no longer read -- honouring it would be an unauthenticated way
// to change what is fetched.
func TestJournalIgnoresTheRetiredQueryHeader(t *testing.T) {
	cluster := newFakeCluster(t)

	recorder := serveJournal("/v1/nodes/node-1/journal", map[string]string{
		"Authorization":     "Bearer user-token",
		"X-Node-Logs-Query": "unit=sshd&tailLines=10",
	})

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", recorder.Code, recorder.Body.String())
	}
	if len(cluster.journalQuery) != 1 || cluster.journalQuery[0] != "" {
		t.Errorf("node-logs-api queries = %q, want [\"\"]", cluster.journalQuery)
	}
}

func TestJournalRejectsInvalidNodeName(t *testing.T) {
	cluster := newFakeCluster(t)

	recorder := serveJournal("/v1/nodes/Node_1/journal", userCredentials)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %q)", recorder.Code, recorder.Body.String())
	}
	if len(cluster.reviews) != 0 {
		t.Errorf("access reviews = %d, want none for a name that cannot be a node", len(cluster.reviews))
	}
}

func TestJournalRoutesAreMountedOnTheProxyPathOnly(t *testing.T) {
	newFakeCluster(t)

	// The asset route the journal used to be served on is gone; it now falls
	// through to whatever else the mux has, which in the real binary is the
	// static frontend.
	recorder := serveJournal("/api/plugins/logging-console-plugin/api/nodes/node-1/journal", userCredentials)
	if recorder.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404 for the retired asset-route path", recorder.Code)
	}
}
