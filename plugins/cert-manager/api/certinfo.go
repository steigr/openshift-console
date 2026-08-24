package api

import (
	"context"
	"encoding/base64"
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
	"DNSEndpoint": {plural: "dnsendpoints", namespaced: true, hostnames: hostnamesForDNSEndpointObj},
}

// certInfoTarget is the JSON shape base64url-encoded into the certinfo
// route's {payload} segment: a GVK plus an optional namespace and name.
// name given -> a single object; namespace only -> every matching object in
// that namespace; neither -> every matching object across the cluster.
type certInfoTarget struct {
	Group     string `json:"group"`
	Version   string `json:"version"`
	Kind      string `json:"kind"`
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name,omitempty"`
}

// ResourceCertResult is one hostname's live TLS certificate state, tagged
// with which resource and object it came from - certinfo's response is a
// flat list of these (a resource with N hostnames produces N entries, a
// namespace/cluster listing produces one batch of entries per object).
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

// certInfoForObject derives obj's hostname(s) and probes each concurrently,
// producing one ResourceCertResult per hostname (or a single entry
// carrying only ResourceError if no hostname could be derived at all).
func certInfoForObject(ctx context.Context, kind string, entry kindEntry, obj unstructuredObject) []ResourceCertResult {
	namespace, name := objMeta(obj)
	hosts := entry.hostnames(obj)
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
		// Same bridge-proxy-drops-the-query-string constraint as
		// certcheck.go/certinspect.go - the GVK(+namespace)(+name) target
		// travels as a base64url-encoded JSON path segment.
		mux.HandleFunc(basePath+"/api/v1/certinfo/{payload}", certInfoHandler)
	})
}

func certInfoHandler(w http.ResponseWriter, r *http.Request) {
	client, err := newInClusterK8sClient()
	if err != nil {
		http.Error(w, "backend is not running in-cluster: "+err.Error(), http.StatusInternalServerError)
		return
	}
	certInfoHandlerWithClient(w, r, client)
}

// certInfoHandlerWithClient is certInfoHandler's implementation, taking the
// k8sClient as a parameter so tests can inject one pointed at a fake
// kube-apiserver instead of the real in-cluster ServiceAccount mount.
func certInfoHandlerWithClient(w http.ResponseWriter, r *http.Request, client *k8sClient) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	raw, err := base64.RawURLEncoding.DecodeString(r.PathValue("payload"))
	if err != nil {
		http.Error(w, "invalid payload: not base64url", http.StatusBadRequest)
		return
	}
	var target certInfoTarget
	if err := json.Unmarshal(raw, &target); err != nil {
		http.Error(w, "invalid payload: not a JSON object", http.StatusBadRequest)
		return
	}

	entry, ok := kindRegistry[target.Kind]
	if !ok {
		known := make([]string, 0, len(kindRegistry))
		for k := range kindRegistry {
			known = append(known, k)
		}
		http.Error(w, fmt.Sprintf("unsupported kind %q, must be one of: %s", target.Kind, strings.Join(known, ", ")), http.StatusBadRequest)
		return
	}
	if target.Name != "" && target.Namespace == "" && entry.namespaced {
		http.Error(w, "namespace is required when name is given for a namespaced kind", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), checkTimeout)
	defer cancel()

	var objects []unstructuredObject
	if target.Name != "" {
		obj, err := client.getResource(ctx, target.Group, target.Version, entry.plural, target.Namespace, target.Name)
		if err != nil {
			http.Error(w, "fetching resource: "+err.Error(), http.StatusBadGateway)
			return
		}
		objects = []unstructuredObject{obj}
	} else {
		objects, err = client.listResources(ctx, target.Group, target.Version, entry.plural, target.Namespace)
		if err != nil {
			http.Error(w, "listing resources: "+err.Error(), http.StatusBadGateway)
			return
		}
	}

	var results []ResourceCertResult
	for _, obj := range objects {
		results = append(results, certInfoForObject(ctx, target.Kind, entry, obj)...)
	}
	if results == nil {
		results = []ResourceCertResult{}
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	json.NewEncoder(w).Encode(results)
}
