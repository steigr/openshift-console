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

const serviceAccountDir = "/var/run/secrets/kubernetes.io/serviceaccount"

// DNS-1123 subdomain, which is what node names must be.
var nodeNameRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`)

func init() {
	Register(func(mux *http.ServeMux) {
		mux.HandleFunc("GET "+path("/nodes/{node}/journal"), journalProxyHandler)
		mux.HandleFunc("GET "+path("/nodes/{node}/journal/raw"), journalRawProxyHandler)
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
func lookupNodeLogsPod(node string) (string, error) {
	k8sOnce.Do(initK8s)
	if k8sInitErr != nil {
		return "", k8sInitErr
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
		fmt.Sprintf("%s/api/v1/namespaces/%s/pods?%s", k8sBase, namespace, query.Encode()),
		nil,
	)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))

	resp, err := k8sClient.Do(req)
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

// effectiveQuery returns the journal query for the request. The console's
// plugin proxy drops query strings when forwarding, so the frontend also
// sends the journal query in a header.
func effectiveQuery(r *http.Request) string {
	if r.URL.RawQuery != "" {
		return r.URL.RawQuery
	}
	if headerQuery := r.Header.Get("X-Node-Logs-Query"); headerQuery != "" {
		if _, err := url.ParseQuery(headerQuery); err == nil {
			return headerQuery
		}
	}
	return ""
}

func journalProxyHandler(w http.ResponseWriter, r *http.Request) {
	proxyJournal(w, r, effectiveQuery(r))
}

// journalRawProxyHandler serves the "open the raw file in another window"
// link of the console's abridged-log alert: the full journal, no tail limit.
func journalRawProxyHandler(w http.ResponseWriter, r *http.Request) {
	values, err := url.ParseQuery(effectiveQuery(r))
	if err != nil {
		values = url.Values{}
	}
	values.Set("tailLines", "0")
	proxyJournal(w, r, values.Encode())
}

func proxyJournal(w http.ResponseWriter, r *http.Request, rawQuery string) {
	node := r.PathValue("node")
	if !nodeNameRE.MatchString(node) {
		http.Error(w, "invalid node name", http.StatusBadRequest)
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
