package api

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// serviceAccountDir is a var, not a const, so tests can point it at a
// throwaway directory instead of the real in-cluster mount.
var serviceAccountDir = "/var/run/secrets/kubernetes.io/serviceaccount"

// DNS-1123 subdomain, which is what node names must be.
var nodeNameRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`)

// These routes are served over console's plugin proxy
// (/api/proxy/plugin/node-logging-console-plugin/api/...), which strips that
// prefix and passes the method, query string and body through untouched --
// unlike the plugin asset route, which drops the query string and would force
// the journal query into a header or a path segment.
func init() {
	Register(func(mux *http.ServeMux) {
		mux.HandleFunc("GET /v1/nodes/{node}/journal", journalProxyHandler)
		mux.HandleFunc("GET /v1/nodes/{node}/journal/raw", journalRawProxyHandler)
	})
}

var (
	k8sOnce    sync.Once
	k8sBase    string
	k8sClient  *http.Client
	k8sInitErr error
)

// initK8s prepares an HTTP client that talks to the API server using the
// pod's ServiceAccount CA. The (rotating) token is read per request.
func initK8s() {
	host := os.Getenv("KUBERNETES_SERVICE_HOST")
	port := os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		k8sInitErr = fmt.Errorf("not running in a Kubernetes cluster")
		return
	}
	caCert, err := os.ReadFile(serviceAccountDir + "/ca.crt")
	if err != nil {
		k8sInitErr = fmt.Errorf("reading ServiceAccount CA: %w", err)
		return
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caCert) {
		k8sInitErr = fmt.Errorf("parsing ServiceAccount CA")
		return
	}
	k8sBase = "https://" + net.JoinHostPort(host, port)
	k8sClient = &http.Client{
		Timeout:   10 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}},
	}
}

// k8sAPI returns the API server base URL and a client trusting the cluster
// CA. No credentials live on the client: the pod lookup below sends this
// plugin's own token, while the access review in credentials.go sends the
// caller's, so the two share nothing but the transport.
func k8sAPI() (string, *http.Client, error) {
	k8sOnce.Do(initK8s)
	if k8sInitErr != nil {
		return "", nil, k8sInitErr
	}
	return k8sBase, k8sClient, nil
}

type podList struct {
	Items []struct {
		Metadata struct {
			Name string `json:"name"`
		} `json:"metadata"`
		Status struct {
			Phase string `json:"phase"`
			PodIP string `json:"podIP"`
		} `json:"status"`
	} `json:"items"`
}

// lookupNodeLogsPod returns the IP of the running node-logs-api pod on the
// given node.
//
// This deliberately runs as the plugin's own ServiceAccount (the Role in the
// chart) rather than as the caller: a user allowed to read node logs is
// normally not allowed to list pods in this namespace, and the pod is an
// implementation detail of how the logs are fetched, not something the caller
// asked for. The caller's own permission is checked separately, by
// authorizeNodeLogs.
func lookupNodeLogsPod(node string) (string, error) {
	base, client, err := k8sAPI()
	if err != nil {
		return "", err
	}

	namespace := GetEnv("NODE_LOGS_API_NAMESPACE", "")
	if namespace == "" {
		ns, err := os.ReadFile(serviceAccountDir + "/namespace")
		if err != nil {
			return "", fmt.Errorf("determining namespace: %w", err)
		}
		namespace = strings.TrimSpace(string(ns))
	}
	selector := GetEnv("NODE_LOGS_API_SELECTOR", "app.kubernetes.io/name=node-logs-api")

	token, err := os.ReadFile(serviceAccountDir + "/token")
	if err != nil {
		return "", fmt.Errorf("reading ServiceAccount token: %w", err)
	}

	query := url.Values{
		"labelSelector": {selector},
		"fieldSelector": {"spec.nodeName=" + node + ",status.phase=Running"},
	}
	req, err := http.NewRequest(
		http.MethodGet,
		fmt.Sprintf("%s/api/v1/namespaces/%s/pods?%s", base, namespace, query.Encode()),
		nil,
	)
	if err != nil {
		return "", err
	}
	// Nothing from the inbound request is copied onto this one: pairing this
	// plugin's token with caller-supplied Impersonate-* headers would let a
	// caller borrow the ServiceAccount's own permissions.
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("listing node-logs-api pods: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("listing node-logs-api pods: %s: %s", resp.Status, body)
	}

	var pods podList
	if err := json.NewDecoder(resp.Body).Decode(&pods); err != nil {
		return "", fmt.Errorf("decoding pod list: %w", err)
	}
	for _, pod := range pods.Items {
		if pod.Status.PodIP != "" {
			return pod.Status.PodIP, nil
		}
	}
	return "", fmt.Errorf("no running node-logs-api pod found on node %s", node)
}

// journalProxyHandler serves the journal query as it arrived: the plugin
// proxy hands the caller's query string over untouched, so it is passed on
// verbatim rather than re-encoded.
func journalProxyHandler(w http.ResponseWriter, r *http.Request) {
	proxyJournal(w, r, r.URL.RawQuery)
}

// journalRawProxyHandler serves the "open the raw file in another window"
// link of the console's abridged-log alert: the full journal, no tail limit.
func journalRawProxyHandler(w http.ResponseWriter, r *http.Request) {
	values := r.URL.Query()
	values.Set("tailLines", "0")
	proxyJournal(w, r, values.Encode())
}

func proxyJournal(w http.ResponseWriter, r *http.Request, rawQuery string) {
	node := r.PathValue("node")
	if !nodeNameRE.MatchString(node) {
		http.Error(w, "invalid node name", http.StatusBadRequest)
		return
	}

	// Authorize the caller before anything else: everything below runs as
	// this plugin's own ServiceAccount, so this check is the only thing
	// keeping node logs behind the user's own permissions -- and answering
	// before the pod lookup keeps it from reporting on cluster internals to
	// someone who may not see them.
	if status, err := authorizeNodeLogs(r, node); err != nil {
		log.Printf("journal proxy: %v", err)
		http.Error(w, err.Error(), status)
		return
	}

	podIP, err := lookupNodeLogsPod(node)
	if err != nil {
		log.Printf("journal proxy: %v", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	port := GetEnv("NODE_LOGS_API_PORT", "9080")
	target := fmt.Sprintf("http://%s/journal", net.JoinHostPort(podIP, port))
	if rawQuery != "" {
		target += "?" + rawQuery
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("journal proxy: fetching %s: %v", target, err)
		http.Error(w, fmt.Sprintf("fetching node logs: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if contentType := resp.Header.Get("Content-Type"); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}
