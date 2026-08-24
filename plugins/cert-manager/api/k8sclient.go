package api

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
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

// k8sClient is a minimal in-cluster Kubernetes API client - just enough to
// GET a single object or LIST a collection by group/version/resource, using
// the pod's own ServiceAccount for auth. Deliberately hand-rolled against
// net/http rather than pulling in client-go/apimachinery: this plugin only
// ever needs generic get/list-as-JSON for a handful of known kinds (see
// certinfo.go's kindRegistry), which doesn't need a typed, generated
// clientset or the dependency weight that comes with one.
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
	host := os.Getenv("KUBERNETES_SERVICE_HOST")
	port := os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, errors.New("not running in-cluster: KUBERNETES_SERVICE_HOST/KUBERNETES_SERVICE_PORT not set")
	}

	caBytes, err := os.ReadFile(serviceAccountCAFile)
	if err != nil {
		return nil, fmt.Errorf("reading service account CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caBytes) {
		return nil, errors.New("no certificates found in service account CA file")
	}

	return &k8sClient{
		baseURL: fmt.Sprintf("https://%s:%s", host, port),
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

// do performs an authenticated GET against the given API server path and
// decodes the JSON response into out.
func (c *k8sClient) do(ctx context.Context, path string, out interface{}) error {
	token, err := bearerToken()
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var status struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&status)
		if status.Message != "" {
			return fmt.Errorf("kube-apiserver %s: %s", resp.Status, status.Message)
		}
		return fmt.Errorf("kube-apiserver returned %s for %s", resp.Status, path)
	}

	return json.NewDecoder(resp.Body).Decode(out)
}

// unstructuredObject is a decode target for a single object of any kind -
// just enough structure to read metadata plus arbitrary spec/status via a
// raw map for kind-specific field access.
type unstructuredObject = map[string]interface{}

// unstructuredList is a decode target for a Kubernetes List response.
type unstructuredList struct {
	Items []unstructuredObject `json:"items"`
}

// getResource fetches a single namespaced object by group/version/plural.
func (c *k8sClient) getResource(ctx context.Context, group, version, plural, namespace, name string) (unstructuredObject, error) {
	var obj unstructuredObject
	if err := c.do(ctx, resourcePath(group, version, plural, namespace, name), &obj); err != nil {
		return nil, err
	}
	return obj, nil
}

// listResources lists objects by group/version/plural, scoped to namespace
// when non-empty, or across every namespace when namespace is "".
func (c *k8sClient) listResources(ctx context.Context, group, version, plural, namespace string) ([]unstructuredObject, error) {
	var list unstructuredList
	if err := c.do(ctx, resourcePath(group, version, plural, namespace, ""), &list); err != nil {
		return nil, err
	}
	return list.Items, nil
}
