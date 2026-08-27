package api

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strconv"
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

// Which address families to resolve/consider - both on by default. When a
// family is disabled, its A/AAAA records are never queried at all, and its
// record-type-prefixed TXT ownership check (a-<name> / aaaa-<name> - see
// txtRecordTypePrefixes below) is skipped too, since a claim for a record
// type this backend doesn't look up is not useful to report on.
var (
	enableIPv4 = envBoolOrDefault("EXTERNAL_DNS_ENABLE_IPV4", true)
	enableIPv6 = envBoolOrDefault("EXTERNAL_DNS_ENABLE_IPV6", true)
)

// txtHeritageMarker is the substring external-dns writes into its registry TXT
// records (e.g. `heritage=external-dns,external-dns/owner=default`). A DNS
// name is considered "managed" when its TXT record contains this marker.
var txtHeritageMarker = envOrDefault("EXTERNAL_DNS_TXT_HERITAGE_MARKER", "heritage=external-dns")

// txtOwnerKey is the key external-dns' TXT registry writes the managing
// instance's --txt-owner-id under (e.g. "external-dns/owner=home").
const txtOwnerKey = "external-dns/owner"

const lookupTimeout = 5 * time.Second

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

// lookupHost resolves name's A and/or AAAA records (as plain IP strings, per
// the enableIPv4/enableIPv6 family toggles) over classic UDP/TCP DNS against
// the given plain resolver address. Same injectable-var shape as lookupTXT,
// for the same testing reasons.
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

	var networks []string
	if enableIPv4 {
		networks = append(networks, "ip4")
	}
	if enableIPv6 {
		networks = append(networks, "ip6")
	}
	if len(networks) == 0 {
		return nil, nil
	}

	var mu sync.Mutex
	var wg sync.WaitGroup
	var addrs []string
	var firstErr error

	for _, network := range networks {
		wg.Add(1)
		go func(network string) {
			defer wg.Done()
			ips, err := r.LookupIP(ctx, network, name)
			if err != nil {
				if dnsErr, ok := err.(*net.DNSError); ok && dnsErr.IsNotFound {
					return
				}
				mu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				mu.Unlock()
				return
			}
			mu.Lock()
			for _, ip := range ips {
				addrs = append(addrs, ip.String())
			}
			mu.Unlock()
		}(network)
	}
	wg.Wait()

	if len(addrs) == 0 && firstErr != nil {
		return nil, firstErr
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

// txtRecordTypePrefixes returns the record-type prefixes external-dns' TXT
// registry falls back to (e.g. "a-<name>", "aaaa-<name>") when a name has
// endpoints of more than one record type - claiming ownership at the bare
// name would then be ambiguous about which RRset it covers. Whether a given
// name actually used the bare form or a prefixed one depends on what else
// shares that name, so all variants have to be checked. "a-"/"aaaa-" are
// only included when their address family is enabled - a claim for a record
// type this backend doesn't resolve isn't useful to report on. "" (bare) and
// "cname-" aren't family-specific, so they're always checked.
func txtRecordTypePrefixes() []string {
	prefixes := []string{""}
	if enableIPv4 {
		prefixes = append(prefixes, "a-")
	}
	if enableIPv6 {
		prefixes = append(prefixes, "aaaa-")
	}
	return append(prefixes, "cname-")
}

// resolveHostname checks whether hostname carries an external-dns registry
// TXT ownership record - at the bare name or one of its record-type-prefixed
// variants - and if so which instance (--txt-owner-id) claims it. The
// returned duration is how long the result should be cached for - always
// fallbackCacheTTL since plain DNS doesn't expose real TTLs (see cache.go).
func resolveHostname(ctx context.Context, resolver, hostname string) (HostnameResult, time.Duration) {
	result := HostnameResult{Hostname: hostname}

	var mu sync.Mutex
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		managed, ownerID, err := lookupTXTOwnership(ctx, resolver, hostname)
		mu.Lock()
		defer mu.Unlock()
		result.Managed = managed
		result.OwnerID = ownerID
		if err != nil && result.Error == "" {
			result.Error = err.Error()
		}
	}()

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

// lookupTXTOwnership checks hostname's external-dns registry TXT claim - at
// the bare name or one of its record-type-prefixed variants (see
// txtRecordTypePrefixes) - concurrently, and returns whether it's managed
// and by which --txt-owner-id. Shared by resolveHostname and
// resolveDNSSettings (dnssettings.go).
func lookupTXTOwnership(ctx context.Context, resolver, hostname string) (managed bool, ownerID string, err error) {
	var mu sync.Mutex
	var wg sync.WaitGroup
	var firstErr error

	for _, prefix := range txtRecordTypePrefixes() {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			records, lookupErr := lookupTXT(ctx, resolver, name)
			mu.Lock()
			defer mu.Unlock()
			if lookupErr != nil {
				if firstErr == nil {
					firstErr = lookupErr
				}
				return
			}
			for _, data := range records {
				if isManaged, owner := parseTXTClaim(data); isManaged {
					managed = true
					if owner != "" {
						ownerID = owner
					}
				}
			}
		}(prefix + hostname)
	}
	wg.Wait()

	return managed, ownerID, firstErr
}

// basePath must match this plugin's ConsolePlugin name (see
// charts/console-external-dns-plugin/templates/consoleplugin.yaml and
// plugin-manifest.ts's pluginMetadata.name/baseURL). It is kept only for
// direct/local pod access - see init() below for why it must NOT be used
// for routes reached through console's actual proxy.
const basePath = "/api/plugins/external-dns-console-plugin"

// defaultResolverSegment is the sentinel a caller passes as the {resolver}
// path segment to mean "use this backend's configured default resolver"
// (EXTERNAL_DNS_RESOLVER, or its own built-in default).
const defaultResolverSegment = "default"

func init() {
	Register(func(mux *http.ServeMux) {
		// Console's bridge proxy for a dynamic plugin's backend routes
		// (pkg/plugins/handlers.go's HandlePluginAssets) strips the
		// "/api/plugins/<plugin-name>/" prefix entirely before forwarding,
		// issues nothing but a bare GET, and never forwards the original
		// request's body or query string - it builds the upstream request
		// as http.NewRequest("GET", url, nil) from the plugin service's own
		// basePath (see consoleplugin.yaml's spec.backend.service.basePath,
		// "/") joined with the remaining path alone. So this route must be
		// registered bare (no "/api/plugins/<name>" prefix). A bare DNS
		// hostname is already a valid, readable path segment on its own, so
		// no payload encoding is needed at all - callers wanting several
		// hostnames (e.g. a list view) issue one request per hostname
		// (concurrency-limited client-side, e.g. 10 in flight) rather than a
		// single batched call. See cert-manager's api/certinfo.go init() and
		// flux's api/reconcile.go init() for the same fix applied there.
		mux.HandleFunc("/api/v1/inspect/{resolver}/{hostname}", inspectHostnameHandler)
		mux.HandleFunc(basePath+"/api/v1/inspect/{resolver}/{hostname}", inspectHostnameHandler)
	})
}

// inspectHostnameHandler serves a single hostname's registry-ownership
// lookup as a plain, bookmarkable REST path: .../inspect/<resolver>/<hostname>,
// or .../inspect/default/<hostname> to use the backend's configured default
// resolver (see defaultResolverSegment).
func inspectHostnameHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	resolver := defaultResolver
	if seg := r.PathValue("resolver"); seg != "" && seg != defaultResolverSegment {
		resolver = seg
	}

	hostname := strings.TrimSpace(r.PathValue("hostname"))
	if hostname == "" {
		http.Error(w, "hostname is required", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), lookupTimeout)
	defer cancel()

	result := cachedLookupHostname(ctx, resolver, hostname)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	json.NewEncoder(w).Encode(result)
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBoolOrDefault(key string, def bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}
