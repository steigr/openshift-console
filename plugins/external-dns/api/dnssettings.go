package api

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// DNSRecord is one resolved record backing a hostname - its type (A/AAAA/
// CNAME), value, and the TTL the authoritative/resolving server reported
// for it, in seconds.
type DNSRecord struct {
	Type  string `json:"type"`
	Value string `json:"value"`
	TTL   uint32 `json:"ttl"`
}

// DNSSettingsResult is the full "DNS Settings" view for one hostname: its
// external-dns registry ownership (same as HostnameResult) plus every A/
// AAAA/CNAME record backing it, each with its own TTL.
type DNSSettingsResult struct {
	Hostname string      `json:"hostname"`
	Managed  bool        `json:"managed"`
	OwnerID  string      `json:"ownerId,omitempty"`
	Records  []DNSRecord `json:"records,omitempty"`
	Error    string      `json:"error,omitempty"`
}

var dnsSettingsCache = newResultCache[DNSSettingsResult]()

// resolveDNSSettings resolves hostname's TXT registry ownership and its A/
// AAAA/CNAME records (each with its real TTL, via the hand-rolled client in
// dnsquery.go - net.Resolver never exposes one). The returned TTL is the
// lowest of every record found (so the cache never outlives the
// shortest-lived record), falling back to fallbackCacheTTL when nothing was
// found at all.
func resolveDNSSettings(ctx context.Context, resolver, hostname string) (DNSSettingsResult, time.Duration) {
	result := DNSSettingsResult{Hostname: hostname}

	var mu sync.Mutex
	var wg sync.WaitGroup
	var firstErr error
	var minTTL uint32
	haveTTL := false

	wg.Add(1)
	go func() {
		defer wg.Done()
		managed, ownerID, err := lookupTXTOwnership(ctx, resolver, hostname)
		mu.Lock()
		defer mu.Unlock()
		result.Managed = managed
		result.OwnerID = ownerID
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}()

	for _, qtype := range [...]uint16{dnsTypeA, dnsTypeAAAA} {
		wg.Add(1)
		go func(qtype uint16) {
			defer wg.Done()
			recs, err := queryRecords(ctx, resolver, hostname, qtype)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				return
			}
			for _, rr := range recs {
				result.Records = append(result.Records, DNSRecord{
					Type:  dnsRecordTypeName(rr.Type),
					Value: rr.Value,
					TTL:   rr.TTL,
				})
				if !haveTTL || rr.TTL < minTTL {
					minTTL = rr.TTL
					haveTTL = true
				}
			}
		}(qtype)
	}
	wg.Wait()

	if len(result.Records) == 0 && firstErr != nil {
		result.Error = firstErr.Error()
	}

	ttl := fallbackCacheTTL
	if haveTTL {
		ttl = clampCacheTTL(time.Duration(minTTL) * time.Second)
	}
	return result, ttl
}

// cachedResolveDNSSettings wraps resolveDNSSettings with the same TTL-aware
// cache cachedLookupHostname uses (see cache.go's cachedFetch), except
// caching is skipped entirely for the cluster's own internal DNS (kube-dns/
// CoreDNS) - see isInternalClusterResolver's doc comment for why.
func cachedResolveDNSSettings(ctx context.Context, resolver, hostname string) DNSSettingsResult {
	skip := isInternalClusterResolver(resolver)
	return cachedFetch(ctx, dnsSettingsCache, cacheKey(resolver, hostname), skip, func(ctx context.Context) (DNSSettingsResult, time.Duration) {
		return resolveDNSSettings(ctx, resolver, hostname)
	})
}

// internalResolverSuffixes/Substrings identify a resolver as this cluster's
// own internal DNS service (kube-dns or CoreDNS) by the conventional names
// those get - the resolv.conf-derived IPs in internalResolverIPs cover the
// common case (a resolver address handed out via that pod's own DNS
// config), these cover an explicit override by hostname.
var (
	internalResolverSuffixes = [...]string{".svc", ".svc.cluster.local"}
	internalResolverNeedles  = [...]string{"kube-dns", "coredns"}
)

// internalResolverIPs is populated once, at package init, from this pod's
// own /etc/resolv.conf nameserver entries - which, unless something unusual
// is going on, ARE the cluster's internal kube-dns/CoreDNS Service
// ClusterIP(s). Used to recognize an internal resolver even when a caller
// passes its bare IP rather than a DNS name.
var internalResolverIPs = loadResolvConfNameservers("/etc/resolv.conf")

func loadResolvConfNameservers(path string) map[string]struct{} {
	ips := make(map[string]struct{})
	f, err := os.Open(path)
	if err != nil {
		return ips
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 && fields[0] == "nameserver" {
			ips[fields[1]] = struct{}{}
		}
	}
	return ips
}

// isInternalClusterResolver reports whether resolver is this cluster's own
// internal DNS (kube-dns/CoreDNS) rather than an external/upstream one.
//
// dnsSettingsCache/cache exist specifically so a page with many rows
// doesn't flood whatever resolver it's configured to use - but that concern
// only applies to a resolver actually out on the network somewhere: the
// in-cluster DNS service is itself a highly-available, horizontally-scaled
// component built to take exactly this kind of query volume, so bypassing
// the cache for it trades a little redundant local traffic for always-fresh
// results instead of tolerating up to fallbackCacheTTL of staleness.
var isInternalClusterResolver = func(resolver string) bool {
	host := resolver
	if h, _, err := net.SplitHostPort(resolver); err == nil {
		host = h
	}
	host = strings.ToLower(strings.TrimSuffix(host, "."))

	if _, ok := internalResolverIPs[host]; ok {
		return true
	}
	for _, suffix := range internalResolverSuffixes {
		if strings.HasSuffix(host, suffix) {
			return true
		}
	}
	for _, needle := range internalResolverNeedles {
		if strings.Contains(host, needle) {
			return true
		}
	}
	return false
}

func init() {
	Register(func(mux *http.ServeMux) {
		// Same bare-registration requirement as inspectHostnameHandler in
		// lookup.go (bridge's proxy strips the plugin-name prefix).
		mux.HandleFunc("/api/v1/dns-settings/{resolver}/{hostname}", dnsSettingsHandler)
		mux.HandleFunc(basePath+"/api/v1/dns-settings/{resolver}/{hostname}", dnsSettingsHandler)
	})
}

// dnsSettingsHandler serves the "DNS Settings" tab's per-resource data: a
// plain REST path, .../dns-settings/<resolver>/<hostname> (or
// .../dns-settings/default/<hostname> for the backend's configured default
// resolver), the same convention as inspectHostnameHandler.
func dnsSettingsHandler(w http.ResponseWriter, r *http.Request) {
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

	result := cachedResolveDNSSettings(ctx, resolver, hostname)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	json.NewEncoder(w).Encode(result)
}
