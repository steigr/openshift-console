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
// object and PATCH its metadata via a JSON merge patch, authenticated with
// the credentials of the inbound request being served (see credentials.go),
// which is why every call here takes that request. Deliberately hand-rolled
// against net/http rather
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
// pod gets automatically. No credentials are held on the client itself: they
// come from each inbound request (see applyCredentials), and in
// USE_SERVICE_ACCOUNT_TOKEN mode the pod's token is re-read from disk per
// request (see bearerToken) rather than cached, since projected
// ServiceAccount tokens rotate and kubelet refreshes the file in place.
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

// bearerToken reads the pod's own ServiceAccount token, used only in
// USE_SERVICE_ACCOUNT_TOKEN mode (see credentials.go). A package-level var
// (not a plain func) so tests can substitute a fake token without a real
// ServiceAccount mount present.
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
// and decodes the JSON response into out (when out is non-nil). in is the
// request being served, whose credentials this one is made with - so a
// reconcile PATCH is authorized as whoever clicked it, not as this pod.
func (c *k8sClient) do(ctx context.Context, in *http.Request, method, path, contentType string, body []byte, out interface{}) error {
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
	if err := applyCredentials(req, in); err != nil {
		return &credentialError{err: err}
	}
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

// credentialError marks a failure to put credentials on an outgoing request
// (applyCredentials), as opposed to a failure reported by the API server
// itself - the two want different status codes, see writeCredentialError.
type credentialError struct {
	err error
}

func (e *credentialError) Error() string { return e.err.Error() }

func (e *credentialError) Unwrap() error { return e.err }

// writeCredentialError answers err when it is a credential failure and
// reports whether it did, leaving anything else (an API server error, a
// timeout) to the caller's own error handling. errNoCredentials is the
// caller's problem - the request reached this backend without the credentials
// console only forwards on an authorized plugin proxy route - so it gets 401;
// anything else means USE_SERVICE_ACCOUNT_TOKEN is set but this pod's own
// token is unreadable, which is this deployment's misconfiguration, so 500.
func writeCredentialError(w http.ResponseWriter, err error) bool {
	var credErr *credentialError
	if !errors.As(err, &credErr) {
		return false
	}
	if errors.Is(err, errNoCredentials) {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return true
	}
	http.Error(w, "resolving credentials: "+err.Error(), http.StatusInternalServerError)
	return true
}

// unstructuredObject is a decode target for a single object of any kind -
// just enough structure to read metadata plus arbitrary spec/status via a
// raw map for kind-specific field access.
type unstructuredObject = map[string]interface{}

// getResource fetches a single namespaced object by group/version/plural.
func (c *k8sClient) getResource(ctx context.Context, in *http.Request, group, version, plural, namespace, name string) (unstructuredObject, error) {
	var obj unstructuredObject
	if err := c.do(ctx, in, http.MethodGet, resourcePath(group, version, plural, namespace, name), "", nil, &obj); err != nil {
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
func (c *k8sClient) patchAnnotations(ctx context.Context, in *http.Request, group, version, plural, namespace, name string, annotations map[string]string) error {
	body, err := json.Marshal(map[string]interface{}{
		"metadata": map[string]interface{}{
			"annotations": annotations,
		},
	})
	if err != nil {
		return err
	}
	return c.do(ctx, in, http.MethodPatch, resourcePath(group, version, plural, namespace, name), "application/merge-patch+json", body, nil)
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
