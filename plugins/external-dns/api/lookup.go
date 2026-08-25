package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// defaultResolver is the plain DNS server ("host" or "host:port", port
// defaults to 53) the external-dns registry TXT ownership record is looked
// up from by default, queried over classic UDP/TCP DNS rather than through
// whatever DNS the plugin's pod itself would see. Callers may override this
// per-request (see the optional "resolver" path segment below) - useful when
// a hostname lives on a private/split-horizon zone the configured default
// can't see.
var defaultResolver = envOrDefault("EXTERNAL_DNS_RESOLVER", "1.1.1.1")

// txtHeritageMarker is the substring external-dns writes into its registry TXT
// records (e.g. `heritage=external-dns,external-dns/owner=default`). A DNS
// name is considered "managed" when its TXT record contains this marker.
var txtHeritageMarker = envOrDefault("EXTERNAL_DNS_TXT_HERITAGE_MARKER", "heritage=external-dns")

// txtOwnerKey is the key external-dns' TXT registry writes the managing
// instance's --txt-owner-id under (e.g. "external-dns/owner=home").
const txtOwnerKey = "external-dns/owner"

const (
	maxHostnamesPerRequest = 200
	lookupTimeout          = 5 * time.Second
	maxConcurrentLookups   = 8
)

// HostnameResult is the registry-ownership state of one candidate hostname.
// Managed/OwnerID come solely from the TXT claim record. Addresses are the
// hostname's actual current A/AAAA records, resolved separately so a caller
// can compare them against where the owning K8s resource itself thinks it
// should point (e.g. a Service's LoadBalancer ingress IP) and flag the two
// as out of sync when they disagree.
type HostnameResult struct {
	Hostname  string   `json:"hostname"`
	Managed   bool     `json:"managed"`
	OwnerID   string   `json:"ownerId,omitempty"`
	Addresses []string `json:"addresses,omitempty"`
	Error     string   `json:"error,omitempty"`
}

type lookupRequest struct {
	Hostnames []string `json:"hostnames"`
	Resolver  string   `json:"resolver,omitempty"`
}

// lookupTXT looks up name's TXT records over classic UDP/TCP DNS against the
// given plain resolver address. It's a package-level var (not a plain func)
// so tests can substitute a fake implementation without standing up a real
// DNS server. Go's stdlib resolver doesn't expose the record's TTL, so every
// record found this way is reported with fallbackCacheTTL - see cache.go.
var lookupTXT = func(ctx context.Context, resolver, name string) ([]string, error) {
	server := resolver
	if _, _, err := net.SplitHostPort(server); err != nil {
		server = net.JoinHostPort(server, "53")
	}
	r := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			d := net.Dialer{Timeout: lookupTimeout}
			return d.DialContext(ctx, network, server)
		},
	}
	data, err := r.LookupTXT(ctx, name)
	if err != nil {
		if dnsErr, ok := err.(*net.DNSError); ok && dnsErr.IsNotFound {
			return nil, nil
		}
		return nil, err
	}
	return data, nil
}

// lookupHost resolves name's A/AAAA records (as plain IP strings) over
// classic UDP/TCP DNS against the given plain resolver address. Same
// injectable-var shape as lookupTXT, for the same testing reasons.
var lookupHost = func(ctx context.Context, resolver, name string) ([]string, error) {
	server := resolver
	if _, _, err := net.SplitHostPort(server); err != nil {
		server = net.JoinHostPort(server, "53")
	}
	r := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			d := net.Dialer{Timeout: lookupTimeout}
			return d.DialContext(ctx, network, server)
		},
	}
	addrs, err := r.LookupHost(ctx, name)
	if err != nil {
		if dnsErr, ok := err.(*net.DNSError); ok && dnsErr.IsNotFound {
			return nil, nil
		}
		return nil, err
	}
	return addrs, nil
}

// parseTXTClaim inspects one TXT record's content for external-dns' registry
// heritage marker and, if present, the --txt-owner-id of the instance that
// claims it (e.g. `heritage=external-dns,external-dns/owner=home,...`).
func parseTXTClaim(data string) (managed bool, ownerID string) {
	if !strings.Contains(data, txtHeritageMarker) {
		return false, ""
	}
	for _, field := range strings.Split(data, ",") {
		field = strings.Trim(field, "\" ")
		key, value, ok := strings.Cut(field, "=")
		if ok && strings.TrimSpace(key) == txtOwnerKey {
			return true, strings.TrimSpace(value)
		}
	}
	return true, ""
}

// txtRecordTypePrefixes are the record-type prefixes external-dns' TXT
// registry falls back to (e.g. "a-<name>", "aaaa-<name>") when a name has
// endpoints of more than one record type - claiming ownership at the bare
// name would then be ambiguous about which RRset it covers. Whether a given
// name actually used the bare form or a prefixed one depends on what else
// shares that name, so all variants have to be checked.
var txtRecordTypePrefixes = []string{"", "a-", "aaaa-", "cname-"}

// resolveHostname checks whether hostname carries an external-dns registry
// TXT ownership record - at the bare name or one of its record-type-prefixed
// variants - and if so which instance (--txt-owner-id) claims it. The
// returned duration is how long the result should be cached for - always
// fallbackCacheTTL since plain DNS doesn't expose real TTLs (see cache.go).
func resolveHostname(ctx context.Context, resolver, hostname string) (HostnameResult, time.Duration) {
	result := HostnameResult{Hostname: hostname}

	var mu sync.Mutex
	var wg sync.WaitGroup

	for _, prefix := range txtRecordTypePrefixes {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			records, err := lookupTXT(ctx, resolver, name)
			if err != nil {
				mu.Lock()
				if result.Error == "" {
					result.Error = err.Error()
				}
				mu.Unlock()
				return
			}
			mu.Lock()
			defer mu.Unlock()
			for _, data := range records {
				if managed, ownerID := parseTXTClaim(data); managed {
					result.Managed = true
					if ownerID != "" {
						result.OwnerID = ownerID
					}
				}
			}
		}(prefix + hostname)
	}

	// Address records are never prefixed (only the TXT ownership claim can
	// be) - a single lookup at the bare hostname covers them.
	wg.Add(1)
	go func() {
		defer wg.Done()
		addrs, err := lookupHost(ctx, resolver, hostname)
		if err != nil {
			mu.Lock()
			if result.Error == "" {
				result.Error = err.Error()
			}
			mu.Unlock()
			return
		}
		mu.Lock()
		result.Addresses = addrs
		mu.Unlock()
	}()

	wg.Wait()

	return result, clampCacheTTL(fallbackCacheTTL)
}

// basePath must match the URL path segment this plugin is registered under
// in bridge's --plugins flag (see the HelmRelease: .../api/plugins/external-dns).
// Console's pkg/plugins/handlers.go proxies /api/plugins/<manifest-name>/<rest>
// to <that endpoint>/<rest> - i.e. it re-prepends this same base path onto
// every request, not just the static plugin-manifest.json/JS assets - so a
// custom API route has to live at basePath+route, not at route alone.
const basePath = "/api/plugins/external-dns"

// defaultResolverSegment is the sentinel a caller passes as the {resolver}
// path segment to mean "use this backend's configured default resolver"
// (EXTERNAL_DNS_RESOLVER, or its own built-in default).
const defaultResolverSegment = "default"

func init() {
	Register(func(mux *http.ServeMux) {
		// bridge's plugin proxy (pkg/plugins/handlers.go HandlePluginAssets)
		// only ever issues a bare GET and never forwards the original
		// request's body or query string - it builds the upstream request
		// as http.NewRequest("GET", url, nil) from the endpoint URL's path
		// plus the trailing path segments alone. So both the optional
		// resolver override and the hostname list have to travel as path
		// segments. The hostname list travels as a base64url-encoded JSON
		// array rather than a raw comma-joined string so it's an explicit,
		// unambiguous payload (no per-hostname escaping/decoding rules to
		// keep in sync between frontend and backend).
		mux.HandleFunc(basePath+"/api/v1/lookup/{resolver}/{payload}", lookupPathHandler)
		// Bare paths, unreachable through bridge's proxy but kept for
		// local/direct testing (e.g. a port-forward straight to this pod)
		// where POST and query params work normally.
		mux.HandleFunc("/api/v1/lookup", lookupHandler)
		mux.HandleFunc(basePath+"/api/v1/lookup", lookupHandler)
	})
}

// lookupPathHandler serves the route reachable through bridge's plugin
// proxy: an optional resolver override and the hostname list (a
// base64url-encoded JSON string array, no padding) travel as trailing path
// segments, e.g. .../lookup/default/WyJmb28uZXhhbXBsZS5jb20iXQ, or
// .../lookup/192.168.200.1/<payload> to override the resolver.
func lookupPathHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	resolver := defaultResolver
	if seg := r.PathValue("resolver"); seg != "" && seg != defaultResolverSegment {
		resolver = seg
	}

	raw, err := base64.RawURLEncoding.DecodeString(r.PathValue("payload"))
	if err != nil {
		http.Error(w, "invalid payload: not base64url", http.StatusBadRequest)
		return
	}
	var hostnames []string
	if err := json.Unmarshal(raw, &hostnames); err != nil {
		http.Error(w, "invalid payload: not a JSON string array", http.StatusBadRequest)
		return
	}

	writeLookupResults(w, r, resolver, hostnames)
}

func lookupHandler(w http.ResponseWriter, r *http.Request) {
	var hostnames []string
	resolver := defaultResolver

	switch r.Method {
	case http.MethodGet:
		hostnames = r.URL.Query()["hostname"]
		if v := r.URL.Query().Get("resolver"); v != "" {
			resolver = v
		}
	case http.MethodPost:
		var req lookupRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		hostnames = req.Hostnames
		if req.Resolver != "" {
			resolver = req.Resolver
		}
	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	writeLookupResults(w, r, resolver, hostnames)
}

func writeLookupResults(w http.ResponseWriter, r *http.Request, resolver string, rawHostnames []string) {
	hostnames := dedupeNonEmpty(rawHostnames)
	if len(hostnames) == 0 {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-cache")
		json.NewEncoder(w).Encode(map[string]HostnameResult{})
		return
	}
	if len(hostnames) > maxHostnamesPerRequest {
		http.Error(w, "too many hostnames in one request", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), lookupTimeout)
	defer cancel()

	results := make(map[string]HostnameResult, len(hostnames))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, maxConcurrentLookups)

	for _, hostname := range hostnames {
		wg.Add(1)
		sem <- struct{}{}
		go func(h string) {
			defer wg.Done()
			defer func() { <-sem }()
			res := cachedLookupHostname(ctx, resolver, h)
			mu.Lock()
			results[h] = res
			mu.Unlock()
		}(hostname)
	}
	wg.Wait()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	json.NewEncoder(w).Encode(results)
}

func dedupeNonEmpty(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
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

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
