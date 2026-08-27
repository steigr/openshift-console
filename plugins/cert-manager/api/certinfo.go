package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
)

// kindEntry describes how to fetch and derive hostnames for one of the
// resource kinds this plugin knows how to enrich - the same fixed set
// wired up as "Certificate" tabs in plugin-manifest.ts. GVK-generic in
// principle, but the plural (needed to build the REST path) and the
// hostname-derivation rule are inherently kind-specific, so this is a
// small hardcoded registry rather than dynamic API discovery.
type kindEntry struct {
	plural     string
	namespaced bool
	hostnames  func(obj unstructuredObject) []string
}

var kindRegistry = map[string]kindEntry{
	"Ingress":     {plural: "ingresses", namespaced: true, hostnames: hostnamesForIngressObj},
	"Service":     {plural: "services", namespaced: true, hostnames: hostnamesForServiceObj},
	"HTTPRoute":   {plural: "httproutes", namespaced: true, hostnames: hostnamesForRouteObj},
	"TLSRoute":    {plural: "tlsroutes", namespaced: true, hostnames: hostnamesForRouteObj},
	"GRPCRoute":   {plural: "grpcroutes", namespaced: true, hostnames: hostnamesForRouteObj},
	"TCPRoute":    {plural: "tcproutes", namespaced: true, hostnames: noStructuralHostnames},
	"UDPRoute":    {plural: "udproutes", namespaced: true, hostnames: noStructuralHostnames},
	"DNSEndpoint": {plural: "dnsendpoints", namespaced: true, hostnames: hostnamesForDNSEndpointObj},
	"Node":        {plural: "nodes", namespaced: false, hostnames: noStructuralHostnames},
}

// clusterScopedSegment is the {namespace} path segment a caller passes for a
// cluster-scoped kind (currently only Node) - a real Kubernetes namespace
// name can never be a bare "-" (must start/end alphanumeric), so it's safe
// as a sentinel with no collision risk.
const clusterScopedSegment = "-"

// ResourceCertResult is one hostname's live TLS certificate state, tagged
// with which resource and object it came from - inspectResourceHandler's
// response is a flat list of these (a resource with N hostnames produces N
// entries). Listing multiple resources is the caller's job: fetch the
// object list from the cluster (already watched client-side) and issue one
// inspect request per object, capped at a small concurrency limit.
type ResourceCertResult struct {
	Kind          string `json:"kind"`
	Namespace     string `json:"namespace,omitempty"`
	Name          string `json:"name"`
	ResourceError string `json:"resourceError,omitempty"`
	HostnameCertResult
}

func objMeta(obj unstructuredObject) (namespace, name string) {
	metadata, _ := obj["metadata"].(map[string]interface{})
	namespace, _ = metadata["namespace"].(string)
	name, _ = metadata["name"].(string)
	return namespace, name
}

// getStringSlice reads obj[path...] as a []string, tolerating any
// intermediate value not being present or not matching the expected shape
// (returns nil rather than erroring - a resource genuinely may not have,
// say, a spec.tls at all).
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

func asObjectSlice(v interface{}) []unstructuredObject {
	raw, ok := v.([]interface{})
	if !ok {
		return nil
	}
	out := make([]unstructuredObject, 0, len(raw))
	for _, item := range raw {
		if m, ok := item.(map[string]interface{}); ok {
			out = append(out, m)
		}
	}
	return out
}

func asStringSlice(v interface{}) []string {
	raw, ok := v.([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}

func uniqStrings(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s == "" {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

// hostnamesForIngressObj mirrors src/utils/hostnames.ts's hostnamesForIngress.
func hostnamesForIngressObj(obj unstructuredObject) []string {
	var hosts []string
	for _, rule := range asObjectSlice(getPath(obj, "spec", "rules")) {
		if host, ok := rule["host"].(string); ok {
			hosts = append(hosts, host)
		}
	}
	for _, tlsEntry := range asObjectSlice(getPath(obj, "spec", "tls")) {
		hosts = append(hosts, asStringSlice(tlsEntry["hosts"])...)
	}
	return uniqStrings(hosts)
}

// hostnamesForServiceObj mirrors hostnamesForService.
func hostnamesForServiceObj(obj unstructuredObject) []string {
	var hosts []string
	for _, ing := range asObjectSlice(getPath(obj, "status", "loadBalancer", "ingress")) {
		if h, ok := ing["hostname"].(string); ok && h != "" {
			hosts = append(hosts, h)
		} else if ip, ok := ing["ip"].(string); ok {
			hosts = append(hosts, ip)
		}
	}
	return uniqStrings(hosts)
}

// hostnamesForRouteObj mirrors hostnamesForHTTPRoute/TLSRoute/GRPCRoute -
// all three share the same spec.hostnames shape.
func hostnamesForRouteObj(obj unstructuredObject) []string {
	return uniqStrings(asStringSlice(getPath(obj, "spec", "hostnames")))
}

// hostnamesForDNSEndpointObj mirrors hostnamesForDNSEndpoint.
func hostnamesForDNSEndpointObj(obj unstructuredObject) []string {
	var hosts []string
	for _, ep := range asObjectSlice(getPath(obj, "spec", "endpoints")) {
		if h, ok := ep["dnsName"].(string); ok {
			hosts = append(hosts, h)
		}
	}
	return uniqStrings(hosts)
}

// noStructuralHostnames is the kindEntry.hostnames for a kind with no
// structural hostname field of its own (Node, TCPRoute, UDPRoute) - its
// hostname(s), if any, come entirely from the annotationHostnames merge in
// certInfoForObject below.
func noStructuralHostnames(unstructuredObject) []string { return nil }

const (
	externalDNSHostnameAnnotation         = "external-dns.alpha.kubernetes.io/hostname"
	externalDNSInternalHostnameAnnotation = "external-dns.alpha.kubernetes.io/internal-hostname"
	externalDNSExcludeAnnotation          = "external-dns.alpha.kubernetes.io/exclude"
)

// splitAnnotationHostnames parses external-dns' comma-joined hostname
// annotation value, mirroring external-dns's own splitHostnameLabel.
func splitAnnotationHostnames(v string) []string {
	var out []string
	for _, h := range strings.Split(v, ",") {
		if h = strings.TrimSpace(h); h != "" {
			out = append(out, h)
		}
	}
	return out
}

// annotationHostnames reads external-dns' hostname/internal-hostname
// annotations off obj - present on any kind external-dns can create records
// for by annotation alone (Node included, for its on-prem/bare-metal
// source), not just kinds with a structural hostname field of their own.
// excluded reports whether external-dns.alpha.kubernetes.io/exclude=true is
// set, in which case obj is never DNS-managed regardless of any other
// signal - mirrors patches/0015-external-dns-column.patch's
// getCandidateHostnames (console core's own DNS column) exactly.
func annotationHostnames(obj unstructuredObject) (hosts []string, excluded bool) {
	metadata, _ := obj["metadata"].(map[string]interface{})
	annotations, _ := metadata["annotations"].(map[string]interface{})
	if annotations == nil {
		return nil, false
	}
	if v, _ := annotations[externalDNSExcludeAnnotation].(string); v == "true" {
		return nil, true
	}
	if v, ok := annotations[externalDNSHostnameAnnotation].(string); ok {
		hosts = append(hosts, splitAnnotationHostnames(v)...)
	}
	if v, ok := annotations[externalDNSInternalHostnameAnnotation].(string); ok {
		hosts = append(hosts, splitAnnotationHostnames(v)...)
	}
	return hosts, false
}

// certInfoForObject derives obj's hostname(s) - its own structural field(s)
// (entry.hostnames) plus external-dns' hostname/internal-hostname
// annotations, which apply to any kind (annotationHostnames) - and probes
// each concurrently, producing one ResourceCertResult per hostname (or a
// single entry carrying only ResourceError if none could be derived at all,
// or if the object opts out via the exclude annotation).
func certInfoForObject(ctx context.Context, kind string, entry kindEntry, obj unstructuredObject) []ResourceCertResult {
	namespace, name := objMeta(obj)

	annotHosts, excluded := annotationHostnames(obj)
	if excluded {
		return []ResourceCertResult{{
			Kind:          kind,
			Namespace:     namespace,
			Name:          name,
			ResourceError: "excluded via the external-dns.alpha.kubernetes.io/exclude annotation",
		}}
	}

	hosts := uniqStrings(append(entry.hostnames(obj), annotHosts...))
	if len(hosts) == 0 {
		return []ResourceCertResult{{
			Kind:          kind,
			Namespace:     namespace,
			Name:          name,
			ResourceError: "no hostname could be determined for this resource",
		}}
	}

	results := make([]ResourceCertResult, len(hosts))
	var wg sync.WaitGroup
	for i, host := range hosts {
		wg.Add(1)
		go func(i int, host string) {
			defer wg.Done()
			results[i] = ResourceCertResult{
				Kind:               kind,
				Namespace:          namespace,
				Name:               name,
				HostnameCertResult: checkHostname(ctx, host, defaultTLSPort),
			}
		}(i, host)
	}
	wg.Wait()
	return results
}

func init() {
	Register(func(mux *http.ServeMux) {
		// See certcheck.go's init() for why this has to be registered bare
		// (no "/api/plugins/<name>" prefix - bridge's proxy strips it).
		// namespace/name/GVK travel as plain, human-readable, bookmarkable
		// path segments - {gvk} is "group~version~kind" (group empty for the
		// core API group, e.g. "~v1~Service"). Callers wanting cert info for
		// several resources (e.g. a list view) issue one request per
		// resource (concurrency-limited client-side, e.g. 10 in flight)
		// rather than a single batched call - see inspectResourceHandler.
		mux.HandleFunc("/api/v1/inspect/ns/{namespace}/{gvk}/{name}", inspectResourceHandler)
		mux.HandleFunc(basePath+"/api/v1/inspect/ns/{namespace}/{gvk}/{name}", inspectResourceHandler)
	})
}

// parseGVKPath parses the inspect route's {gvk} segment, "group~version~kind"
// (group may be empty, for the core API group).
func parseGVKPath(s string) (group, version, kind string, err error) {
	parts := strings.Split(s, "~")
	if len(parts) != 3 {
		return "", "", "", fmt.Errorf("expected group~version~kind, got %q", s)
	}
	return parts[0], parts[1], parts[2], nil
}

func inspectResourceHandler(w http.ResponseWriter, r *http.Request) {
	client, err := newInClusterK8sClient()
	if err != nil {
		http.Error(w, "backend is not running in-cluster: "+err.Error(), http.StatusInternalServerError)
		return
	}
	inspectResourceHandlerWithClient(w, r, client)
}

// inspectResourceHandlerWithClient is inspectResourceHandler's
// implementation, taking the k8sClient as a parameter so tests can inject
// one pointed at a fake kube-apiserver instead of the real in-cluster
// ServiceAccount mount.
func inspectResourceHandlerWithClient(w http.ResponseWriter, r *http.Request, client *k8sClient) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	namespace := r.PathValue("namespace")
	name := r.PathValue("name")
	if namespace == "" || name == "" {
		http.Error(w, "namespace and name are required", http.StatusBadRequest)
		return
	}

	group, version, kind, err := parseGVKPath(r.PathValue("gvk"))
	if err != nil {
		http.Error(w, "invalid gvk: "+err.Error(), http.StatusBadRequest)
		return
	}

	entry, ok := kindRegistry[kind]
	if !ok {
		known := make([]string, 0, len(kindRegistry))
		for k := range kindRegistry {
			known = append(known, k)
		}
		http.Error(w, fmt.Sprintf("unsupported kind %q, must be one of: %s", kind, strings.Join(known, ", ")), http.StatusBadRequest)
		return
	}

	// A cluster-scoped kind (Node) has no namespace of its own - the caller
	// passes clusterScopedSegment in that path position instead, translated
	// here to "" for the actual API call. Reject a mismatch either way
	// rather than silently doing the wrong REST call.
	effectiveNamespace := namespace
	switch {
	case entry.namespaced && namespace == clusterScopedSegment:
		http.Error(w, fmt.Sprintf("kind %q is namespaced, a real namespace is required", kind), http.StatusBadRequest)
		return
	case !entry.namespaced && namespace != clusterScopedSegment:
		http.Error(w, fmt.Sprintf("kind %q is cluster-scoped, use %q as the namespace segment", kind, clusterScopedSegment), http.StatusBadRequest)
		return
	case !entry.namespaced:
		effectiveNamespace = ""
	}

	ctx, cancel := context.WithTimeout(r.Context(), checkTimeout)
	defer cancel()

	obj, err := client.getResource(ctx, group, version, entry.plural, effectiveNamespace, name)
	if err != nil {
		http.Error(w, "fetching resource: "+err.Error(), http.StatusBadGateway)
		return
	}

	results := certInfoForObject(ctx, kind, entry, obj)
	if results == nil {
		results = []ResourceCertResult{}
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	json.NewEncoder(w).Encode(results)
}
