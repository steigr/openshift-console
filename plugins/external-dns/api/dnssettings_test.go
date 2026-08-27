package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIsInternalClusterResolverRecognizesConventionalNames(t *testing.T) {
	cases := map[string]bool{
		"kube-dns.kube-system.svc.cluster.local":    true,
		"kube-dns.kube-system.svc.cluster.local:53": true,
		"coredns.kube-system.svc":                   true,
		"10.96.0.10":                                false, // not in internalResolverIPs unless resolv.conf says so
		"1.1.1.1":                                   false,
		"8.8.8.8:53":                                 false,
		"my-split-horizon-coredns.example.com":       true, // "coredns" substring
	}
	for resolver, want := range cases {
		if got := isInternalClusterResolver(resolver); got != want {
			t.Errorf("isInternalClusterResolver(%q) = %v, want %v", resolver, got, want)
		}
	}
}

func TestIsInternalClusterResolverHonorsResolvConfIPs(t *testing.T) {
	origIPs := internalResolverIPs
	internalResolverIPs = map[string]struct{}{"172.20.0.10": {}}
	t.Cleanup(func() { internalResolverIPs = origIPs })

	if !isInternalClusterResolver("172.20.0.10:53") {
		t.Error("expected the loaded resolv.conf IP to be treated as internal")
	}
	if isInternalClusterResolver("172.20.0.11:53") {
		t.Error("expected an unrelated IP to not be treated as internal")
	}
}

func TestResolveDNSSettingsCollectsRecordsAndOwnership(t *testing.T) {
	newFakeTXT(t, map[string][]string{
		"app.example.com": {"heritage=external-dns,external-dns/owner=home"},
	})
	origHost := lookupHost
	lookupHost = func(context.Context, string, string) ([]string, error) { return nil, nil }
	t.Cleanup(func() { lookupHost = origHost })

	addr := fakeDNSServer(t, func(query []byte) []byte {
		return buildDNSResponse(t, parseQueryID(query), "app.example.com", []dnsRR{
			{Type: dnsTypeA, Value: "203.0.113.5", TTL: 60},
		})
	})

	result, ttl := resolveDNSSettings(t.Context(), addr, "app.example.com")

	if !result.Managed || result.OwnerID != "home" {
		t.Errorf("unexpected ownership: managed=%v owner=%q", result.Managed, result.OwnerID)
	}
	if len(result.Records) == 0 {
		t.Fatalf("expected at least one record, got %+v", result.Records)
	}
	var sawA bool
	for _, rec := range result.Records {
		if rec.Type == "A" && rec.Value == "203.0.113.5" && rec.TTL == 60 {
			sawA = true
		}
	}
	if !sawA {
		t.Errorf("expected an A record for 203.0.113.5, got %+v", result.Records)
	}
	if ttl.Seconds() > 60 {
		t.Errorf("expected the cache TTL to be clamped to the shortest record TTL, got %v", ttl)
	}
}

func TestCachedResolveDNSSettingsSkipsCacheForInternalResolver(t *testing.T) {
	origIsInternal := isInternalClusterResolver
	isInternalClusterResolver = func(string) bool { return true }
	t.Cleanup(func() { isInternalClusterResolver = origIsInternal })

	newFakeTXT(t, map[string][]string{})
	origHost := lookupHost
	lookupHost = func(context.Context, string, string) ([]string, error) { return nil, nil }
	t.Cleanup(func() { lookupHost = origHost })

	var queries int
	addr := fakeDNSServer(t, func(query []byte) []byte {
		queries++
		return buildDNSResponse(t, parseQueryID(query), "internal-cache-test.example.com", []dnsRR{
			{Type: dnsTypeA, Value: "203.0.113.9", TTL: 300},
		})
	})

	for i := 0; i < 3; i++ {
		cachedResolveDNSSettings(t.Context(), addr, "internal-cache-test.example.com")
	}

	// 3 calls x 2 lookups each (A, AAAA) = 6 - if caching were in effect
	// (incorrectly, for an "internal" resolver) this would be 2.
	if queries < 6 {
		t.Errorf("expected every call to hit the resolver fresh (no caching), got %d queries", queries)
	}
}

func TestDNSSettingsHandlerServesResult(t *testing.T) {
	newFakeTXT(t, map[string][]string{
		"handler-test.example.com": {"heritage=external-dns,external-dns/owner=public"},
	})
	origHost := lookupHost
	lookupHost = func(context.Context, string, string) ([]string, error) { return nil, nil }
	t.Cleanup(func() { lookupHost = origHost })

	addr := fakeDNSServer(t, func(query []byte) []byte {
		return buildDNSResponse(t, parseQueryID(query), "handler-test.example.com", []dnsRR{
			{Type: dnsTypeA, Value: "203.0.113.42", TTL: 30},
		})
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/dns-settings/{resolver}/{hostname}", dnsSettingsHandler)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/dns-settings/"+addr+"/handler-test.example.com", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var result DNSSettingsResult
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !result.Managed || result.OwnerID != "public" {
		t.Errorf("unexpected ownership: %+v", result)
	}
	if len(result.Records) == 0 {
		t.Errorf("expected records, got none")
	}
}

func TestDNSSettingsHandlerRejectsNonGET(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/dns-settings/{resolver}/{hostname}", dnsSettingsHandler)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/dns-settings/default/app.example.com", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}
