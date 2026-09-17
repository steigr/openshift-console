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

// defaultResolverSentinel is the value a caller may pass as the "resolver"
// query parameter to mean "use this backend's configured default resolver"
// (EXTERNAL_DNS_RESOLVER, or its own built-in default). Leaving the
// parameter off entirely means exactly the same thing - the sentinel only
// existed because a resolver travelling as a path segment could never be
// empty, and is still accepted so a caller that spells it out keeps working.
const defaultResolverSentinel = "default"

// maxConcurrentLookups caps how many of one batched /v1/lookup request's
// hostnames are resolved at the same time, so a list view asking about every
// row in one call can't turn into a burst of hundreds of simultaneous
// queries at whatever resolver is configured. This cap used to live in the
// frontend (one request per hostname, N in flight - see
// src/api/dnsLookup.ts's mapWithConcurrency); with a batched endpoint the
// number of requests no longer bounds it, so it belongs here.
const maxConcurrentLookups = 10

func init() {
	Register(func(mux *http.ServeMux) {
		// Console's bridge proxies a ConsolePlugin's declared proxy alias
		// (spec.proxy's alias "api" - see
		// charts/console-external-dns-plugin/templates/consoleplugin.yaml) at
		// /api/proxy/plugin/<plugin-name>/api/<rest>: it strips that whole
		// prefix and forwards "/<rest>" to this Service with the original
		// method, query string and body untouched. So routes register bare
		// (no plugin-name prefix) and their arguments travel as ordinary
		// query parameters. The path-segment encoding these routes used
		// before (/api/v1/inspect/{resolver}/{hostname}) only existed because
		// the plugin-asset route bridge served them through
		// (/api/plugins/<name>/..., pkg/plugins/handlers.go's
		// HandlePluginAssets) is built for static assets: a bare GET, with
		// the original request's query string and body dropped entirely.
		mux.HandleFunc("/v1/lookup", lookupHandler)
	})
}

// resolverFromQuery returns the resolver a request asks for: its "resolver"
// query parameter, or this backend's configured default when that parameter
// is absent, empty, or the explicit defaultResolverSentinel. Shared with
// dnsSettingsHandler (dnssettings.go).
func resolverFromQuery(r *http.Request) string {
	if v := strings.TrimSpace(r.URL.Query().Get("resolver")); v != "" && v != defaultResolverSentinel {
		return v
	}
	return defaultResolver
}

// hostnamesFromQuery returns a request's repeated "hostname" query
// parameters, trimmed, with empty and duplicate entries dropped, in the
// order they were given. Duplicates are dropped here rather than left to
// collapse in the response map so the same name isn't resolved twice.
func hostnamesFromQuery(r *http.Request) []string {
	values := r.URL.Query()["hostname"]
	hostnames := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		hostname := strings.TrimSpace(value)
		if hostname == "" {
			continue
		}
		if _, dup := seen[hostname]; dup {
			continue
		}
		seen[hostname] = struct{}{}
		hostnames = append(hostnames, hostname)
	}
	return hostnames
}

// lookupHandler serves the external-dns registry-ownership lookup for one or
// more hostnames: GET /v1/lookup?hostname=<h>&hostname=<h2>&resolver=<r>.
// The response is a JSON object keyed by the requested hostname, so a caller
// that asked about a whole list page's worth of names in one request (e.g.
// the networking plugin's DNSEndpoint column) can index it directly, and a
// caller interested in a single hostname just reads the one key back out.
// Every requested hostname gets an entry, including one whose lookup failed
// or resolved to nothing - its entry carries the error rather than going
// missing.
func lookupHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	hostnames := hostnamesFromQuery(r)
	if len(hostnames) == 0 {
		http.Error(w, "at least one hostname query parameter is required", http.StatusBadRequest)
		return
	}

	resolver := resolverFromQuery(r)

	// Only maxConcurrentLookups hostnames resolve at a time, so a large batch
	// runs as several successive waves - hence one lookupTimeout per wave
	// instead of a single flat one, which the last wave of a big batch would
	// otherwise be cancelled by before it ever got to run.
	waves := (len(hostnames) + maxConcurrentLookups - 1) / maxConcurrentLookups
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(waves)*lookupTimeout)
	defer cancel()

	results := make(map[string]HostnameResult, len(hostnames))
	var mu sync.Mutex
	var wg sync.WaitGroup
	slots := make(chan struct{}, maxConcurrentLookups)

	for _, hostname := range hostnames {
		wg.Add(1)
		go func(hostname string) {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			result := cachedLookupHostname(ctx, resolver, hostname)
			mu.Lock()
			defer mu.Unlock()
			results[hostname] = result
		}(hostname)
	}
	wg.Wait()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	json.NewEncoder(w).Encode(results)
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
