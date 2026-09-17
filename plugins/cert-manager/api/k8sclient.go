package api

import (
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

// k8sClient is a minimal in-cluster Kubernetes API client - just enough to
// GET a single object or LIST a collection by group/version/resource, as
// whoever the request being served belongs to (see credentials.go's
// applyCredentials; the pod's own ServiceAccount is used only when
// USE_SERVICE_ACCOUNT_TOKEN says so). Deliberately hand-rolled against
// net/http rather than pulling in client-go/apimachinery: this plugin only
// ever needs generic get/list-as-JSON for a handful of known kinds (see
// certinfo.go's kindRegistry), which doesn't need a typed, generated
// clientset or the dependency weight that comes with one.
type k8sClient struct {
	baseURL string
	http    *http.Client
}

// newInClusterK8sClient builds a client from the standard in-cluster
// ServiceAccount mount's CA bundle and the KUBERNETES_SERVICE_HOST/PORT env
// vars every pod gets automatically. No credentials are held on the client:
// they are taken from the inbound request (or, with
// USE_SERVICE_ACCOUNT_TOKEN, re-read from disk) per API call, since a
// client is shared across requests from different users and projected
// ServiceAccount tokens rotate in place anyway.
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
		// net.JoinHostPort brackets IPv6 addresses (e.g. "fd10:96::1") as
		// required in a URL authority - this cluster's KUBERNETES_SERVICE_HOST
		// is IPv6, and a plain Sprintf("%s:%s", host, port) produces an
		// unparseable "https://fd10:96::1:443".
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

// credentialError marks a failure to put credentials on an outgoing API
// server request, so a handler can tell it apart from a call that actually
// reached kube-apiserver and answer it as an authentication/configuration
// problem rather than an upstream one - see certinfo.go's
// writeResourceFetchError.
type credentialError struct{ err error }

func (e credentialError) Error() string { return e.err.Error() }
func (e credentialError) Unwrap() error { return e.err }

// do performs an authenticated GET against the given API server path and
// decodes the JSON response into out. in is the inbound request being
// served, whose credentials the outgoing call is made with (see
// credentials.go) - every read this backend does is therefore subject to the
// RBAC of whoever asked for it, not to this pod's own.
func (c *k8sClient) do(ctx context.Context, in *http.Request, path string, out interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return err
	}
	if err := applyCredentials(req, in); err != nil {
		return credentialError{err}
	}
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

// getResource fetches a single namespaced object by group/version/plural,
// with the credentials of the request being served (in).
func (c *k8sClient) getResource(ctx context.Context, in *http.Request, group, version, plural, namespace, name string) (unstructuredObject, error) {
	var obj unstructuredObject
	if err := c.do(ctx, in, resourcePath(group, version, plural, namespace, name), &obj); err != nil {
		return nil, err
	}
	return obj, nil
}
