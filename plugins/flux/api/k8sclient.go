package api

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	serviceAccountDir       = "/var/run/secrets/kubernetes.io/serviceaccount"
	serviceAccountTokenFile = serviceAccountDir + "/token"
	serviceAccountCAFile    = serviceAccountDir + "/ca.crt"
	k8sRequestTimeout       = 10 * time.Second
)

// k8sClient is a minimal in-cluster Kubernetes API client - GET a single
// object and PATCH its metadata via a JSON merge patch, using the pod's own
// ServiceAccount for auth. Deliberately hand-rolled against net/http rather
// than pulling in client-go/apimachinery, same rationale as the sibling
// cert-manager plugin's api/k8sclient.go: this plugin only ever needs
// generic get/patch-as-JSON for the fixed set of Flux kinds `flux reconcile`
// itself supports (see reconcile.go's reconcilableKinds).
type k8sClient struct {
	baseURL string
	http    *http.Client
}

// newInClusterK8sClient builds a client from the standard in-cluster
// ServiceAccount mount and the KUBERNETES_SERVICE_HOST/PORT env vars every
// pod gets automatically. The token is re-read from disk on every request
// (see bearerToken), not cached here, since projected ServiceAccount tokens
// rotate and kubelet refreshes the file in place.
func newInClusterK8sClient() (*k8sClient, error) {
	return newInClusterK8sClientFromPaths(serviceAccountCAFile)
}

// newInClusterK8sClientFromPaths is newInClusterK8sClient's implementation,
// taking the CA file path as a parameter so tests can point it at a
// throwaway cert instead of the real ServiceAccount mount.
func newInClusterK8sClientFromPaths(caFile string) (*k8sClient, error) {
	host := os.Getenv("KUBERNETES_SERVICE_HOST")
	port := os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, errors.New("not running in-cluster: KUBERNETES_SERVICE_HOST/KUBERNETES_SERVICE_PORT not set")
	}

	caBytes, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("reading service account CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caBytes) {
		return nil, errors.New("no certificates found in service account CA file")
	}

	return &k8sClient{
		// net.JoinHostPort brackets IPv6 addresses as required in a URL
		// authority - a plain Sprintf("%s:%s", host, port) would produce an
		// unparseable URL on an IPv6 cluster network.
		baseURL: "https://" + net.JoinHostPort(host, port),
		http: &http.Client{
			Timeout: k8sRequestTimeout,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{RootCAs: pool},
			},
		},
	}, nil
}

// bearerToken is a package-level var (not a plain func) so tests can
// substitute a fake token without a real ServiceAccount mount present.
var bearerToken = func() (string, error) {
	data, err := os.ReadFile(serviceAccountTokenFile)
	if err != nil {
		return "", fmt.Errorf("reading service account token: %w", err)
	}
	return strings.TrimSpace(string(data)), nil
}

// resourcePath builds the REST path for a group/version/plural, optionally
// scoped to a namespace and/or a specific object name.
func resourcePath(group, version, plural, namespace, name string) string {
	var b strings.Builder
	if group == "" {
		b.WriteString("/api/" + version)
	} else {
		b.WriteString("/apis/" + group + "/" + version)
	}
	if namespace != "" {
		b.WriteString("/namespaces/" + namespace)
	}
	b.WriteString("/" + plural)
	if name != "" {
		b.WriteString("/" + name)
	}
	return b.String()
}

// do performs an authenticated request against the given API server path
// and decodes the JSON response into out (when out is non-nil).
func (c *k8sClient) do(ctx context.Context, method, path, contentType string, body []byte, out interface{}) error {
	token, err := bearerToken()
	if err != nil {
		return err
	}

	var bodyReader *bytes.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	} else {
		bodyReader = bytes.NewReader(nil)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bodyReader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var status struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&status)
		if status.Message != "" {
			return fmt.Errorf("kube-apiserver %s: %s", resp.Status, status.Message)
		}
		return fmt.Errorf("kube-apiserver returned %s for %s %s", resp.Status, method, path)
	}

	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// unstructuredObject is a decode target for a single object of any kind -
// just enough structure to read metadata plus arbitrary spec/status via a
// raw map for kind-specific field access.
type unstructuredObject = map[string]interface{}

// getResource fetches a single namespaced object by group/version/plural.
func (c *k8sClient) getResource(ctx context.Context, group, version, plural, namespace, name string) (unstructuredObject, error) {
	var obj unstructuredObject
	if err := c.do(ctx, http.MethodGet, resourcePath(group, version, plural, namespace, name), "", nil, &obj); err != nil {
		return nil, err
	}
	return obj, nil
}

// patchAnnotations applies a JSON merge patch (RFC 7386) that sets the given
// annotations on a single object, without needing to read the object's
// current resourceVersion first (unlike a strategic/JSON-patch, a merge
// patch of just this one field can't conflict with concurrent writes to
// anything else). This is exactly what `flux reconcile` itself does to
// trigger a reconciliation - see reconcile.go's doc comment.
func (c *k8sClient) patchAnnotations(ctx context.Context, group, version, plural, namespace, name string, annotations map[string]string) error {
	body, err := json.Marshal(map[string]interface{}{
		"metadata": map[string]interface{}{
			"annotations": annotations,
		},
	})
	if err != nil {
		return err
	}
	return c.do(ctx, http.MethodPatch, resourcePath(group, version, plural, namespace, name), "application/merge-patch+json", body, nil)
}

// getPath reads obj[path...] tolerating any intermediate value not being
// present or not matching the expected shape (returns nil rather than
// erroring - a resource genuinely may not have, say, spec.chartRef at all).
func getPath(obj interface{}, path ...string) interface{} {
	cur := obj
	for _, p := range path {
		m, ok := cur.(map[string]interface{})
		if !ok {
			return nil
		}
		cur = m[p]
	}
	return cur
}
