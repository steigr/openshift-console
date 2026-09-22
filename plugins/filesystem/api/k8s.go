package api

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
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

// DNS-1123 label/subdomain, which is what namespace, pod and node names are.
var (
	dnsNameRE   = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`)
	containerRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)
)

var (
	k8sOnce    sync.Once
	k8sBase    string
	k8sClient  *http.Client
	k8sInitErr error
)

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
		Timeout:   15 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}},
	}
}

// k8sAPI returns the API server base URL and a client trusting the cluster
// CA. No credentials live on the client: the pod lookup sends the caller's
// forwarded ones and the agent lookup this plugin's own, so the two share
// nothing but the transport.
func k8sAPI() (string, *http.Client, error) {
	k8sOnce.Do(initK8s)
	if k8sInitErr != nil {
		return "", nil, k8sInitErr
	}
	return k8sBase, k8sClient, nil
}

func ownNamespace() (string, error) {
	if ns := GetEnv("POD_NAMESPACE", ""); ns != "" {
		return ns, nil
	}
	ns, err := os.ReadFile(serviceAccountDir + "/namespace")
	if err != nil {
		return "", fmt.Errorf("determining namespace: %w", err)
	}
	return strings.TrimSpace(string(ns)), nil
}

func ownToken() (string, error) {
	token, err := os.ReadFile(serviceAccountDir + "/token")
	if err != nil {
		return "", fmt.Errorf("reading ServiceAccount token: %w", err)
	}
	return strings.TrimSpace(string(token)), nil
}

// podTarget is what the backend needs to know about the pod being browsed:
// which node to find an agent on, and which container on it to name. The
// container ID is enough on its own -- it is unique per container, so nothing
// else has to travel to the agent to pin the request down.
type podTarget struct {
	Node        string
	ContainerID string
	Container   string
}

type podResponse struct {
	Metadata struct {
		Annotations map[string]string `json:"annotations"`
	} `json:"metadata"`
	Spec struct {
		NodeName   string `json:"nodeName"`
		Containers []struct {
			Name string `json:"name"`
		} `json:"containers"`
	} `json:"spec"`
	Status struct {
		Phase             string            `json:"phase"`
		ContainerStatuses []containerStatus `json:"containerStatuses"`
		InitStatuses      []containerStatus `json:"initContainerStatuses"`
		Ephemeral         []containerStatus `json:"ephemeralContainerStatuses"`
	} `json:"status"`
}

type containerStatus struct {
	Name        string `json:"name"`
	ContainerID string `json:"containerID"`
	Ready       bool   `json:"ready"`
	State       struct {
		Running *struct{} `json:"running"`
	} `json:"state"`
}

// resolvePod reads the pod with the *caller's* credentials, not this
// plugin's. Anyone allowed to exec into a pod can already read it, so this
// needs no ServiceAccount permission of its own -- and a user who has lost
// access to the pod between opening the tab and clicking in it gets the API
// server's own answer rather than a cached one.
func resolvePod(ctx context.Context, in http.Header, namespace, pod, container string) (*podTarget, error) {
	if !dnsNameRE.MatchString(namespace) {
		return nil, fmt.Errorf("invalid namespace name")
	}
	if !dnsNameRE.MatchString(pod) {
		return nil, fmt.Errorf("invalid pod name")
	}
	if container != "" && !containerRE.MatchString(container) {
		return nil, fmt.Errorf("invalid container name")
	}

	base, client, err := k8sAPI()
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/api/v1/namespaces/%s/pods/%s", base, url.PathEscape(namespace), url.PathEscape(pod)), nil)
	if err != nil {
		return nil, err
	}
	if err := applyForwardedCredentials(req.Header, in); err != nil {
		return nil, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("reading pod %s/%s: %w", namespace, pod, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, &apiStatusError{status: resp.StatusCode, msg: fmt.Sprintf("reading pod %s/%s: %s: %s", namespace, pod, resp.Status, strings.TrimSpace(string(body)))}
	}

	var parsed podResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decoding pod %s/%s: %w", namespace, pod, err)
	}
	if parsed.Spec.NodeName == "" {
		return nil, fmt.Errorf("pod %s/%s is not scheduled to a node", namespace, pod)
	}

	statuses := make([]containerStatus, 0, len(parsed.Status.ContainerStatuses)+len(parsed.Status.InitStatuses)+len(parsed.Status.Ephemeral))
	statuses = append(statuses, parsed.Status.ContainerStatuses...)
	statuses = append(statuses, parsed.Status.InitStatuses...)
	statuses = append(statuses, parsed.Status.Ephemeral...)

	if container == "" {
		container = defaultContainer(&parsed, statuses)
	}
	for _, status := range statuses {
		if status.Name != container {
			continue
		}
		if status.ContainerID == "" {
			return nil, fmt.Errorf("container %q in pod %s/%s has no running container to browse", container, namespace, pod)
		}
		return &podTarget{
			Node:        parsed.Spec.NodeName,
			ContainerID: status.ContainerID,
			Container:   container,
		}, nil
	}
	return nil, fmt.Errorf("pod %s/%s has no container %q", namespace, pod, container)
}

// defaultContainer picks the container to browse when the frontend has not
// asked for one yet, following the same annotation console core honours for
// its terminal and logs tabs.
func defaultContainer(pod *podResponse, statuses []containerStatus) string {
	if name := pod.Metadata.Annotations["kubectl.kubernetes.io/default-container"]; name != "" {
		return name
	}
	for _, status := range statuses {
		if status.State.Running != nil {
			return status.Name
		}
	}
	if len(pod.Spec.Containers) > 0 {
		return pod.Spec.Containers[0].Name
	}
	return ""
}

// apiStatusError carries the API server's own status so the Connect layer can
// answer 401/403 as such instead of flattening everything to "internal".
type apiStatusError struct {
	status int
	msg    string
}

func (e *apiStatusError) Error() string { return e.msg }
func (e *apiStatusError) Status() int   { return e.status }

type podList struct {
	Items []struct {
		Metadata struct {
			Name string `json:"name"`
		} `json:"metadata"`
		Status struct {
			PodIP string `json:"podIP"`
		} `json:"status"`
	} `json:"items"`
}

// lookupAgent returns the IP of the agent DaemonSet pod on a node.
//
// This is the one call that runs as the plugin's own ServiceAccount: listing
// pods in this namespace is not something a user browsing their own pod's
// files is expected to be allowed to do, and which agent pod serves them is
// an implementation detail of this plugin rather than something they asked
// about. Their own permission was already checked, by authorizeContainerAccess.
func lookupAgent(ctx context.Context, node string) (string, error) {
	if !dnsNameRE.MatchString(node) {
		return "", fmt.Errorf("invalid node name")
	}
	base, client, err := k8sAPI()
	if err != nil {
		return "", err
	}
	namespace, err := ownNamespace()
	if err != nil {
		return "", err
	}
	token, err := ownToken()
	if err != nil {
		return "", err
	}

	selector := GetEnv("AGENT_SELECTOR", "app.kubernetes.io/name=filesystem-agent")
	query := url.Values{
		"labelSelector": {selector},
		"fieldSelector": {"spec.nodeName=" + node + ",status.phase=Running"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/api/v1/namespaces/%s/pods?%s", base, url.PathEscape(namespace), query.Encode()), nil)
	if err != nil {
		return "", err
	}
	// Nothing from the inbound request is copied here: pairing this plugin's
	// token with caller-supplied Impersonate-* headers would let a caller
	// borrow the ServiceAccount's own permissions.
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("listing filesystem agents: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("listing filesystem agents: %s: %s", resp.Status, body)
	}

	var pods podList
	if err := json.NewDecoder(resp.Body).Decode(&pods); err != nil {
		return "", fmt.Errorf("decoding agent pod list: %w", err)
	}
	for _, pod := range pods.Items {
		if pod.Status.PodIP != "" {
			return pod.Status.PodIP, nil
		}
	}
	return "", fmt.Errorf("no running filesystem agent found on node %s: is the DaemonSet scheduled there?", node)
}
