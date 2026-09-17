package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeTXTRecords maps a DNS name to the TXT record contents that stubbed
// lookupTXT should return, letting tests exercise resolveHostname's prefix
// fallback and caching behavior without any real DNS I/O. It also stubs
// lookupHost (defaulting to no addresses for every name) so resolveHostname's
// address resolution never makes a real network call in tests either.
type fakeTXTRecords struct {
	mu      sync.Mutex
	byName  map[string][]string
	calls   int32
	onQuery func(name string)
}

func newFakeTXT(t *testing.T, byName map[string][]string) *fakeTXTRecords {
	t.Helper()
	f := &fakeTXTRecords{byName: byName}

	originalTXT := lookupTXT
	lookupTXT = func(_ context.Context, resolver, name string) ([]string, error) {
		atomic.AddInt32(&f.calls, 1)
		if f.onQuery != nil {
			f.onQuery(name)
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.byName[name], nil
	}
	t.Cleanup(func() { lookupTXT = originalTXT })

	originalHost := lookupHost
	lookupHost = func(_ context.Context, resolver, name string) ([]string, error) {
		return nil, nil
	}
	t.Cleanup(func() { lookupHost = originalHost })

	return f
}

func (f *fakeTXTRecords) callCount() int32 {
	return atomic.LoadInt32(&f.calls)
}

// withTinyCacheTTLs shrinks the cache's TTL floor/ceiling/fallback so
// TTL-timing tests don't need to wait out the real 30s-30min bounds.
func withTinyCacheTTLs(t *testing.T) {
	t.Helper()
	origMin, origMax, origFallback := minCacheTTL, maxCacheTTL, fallbackCacheTTL
	minCacheTTL = 5 * time.Millisecond
	maxCacheTTL = 40 * time.Millisecond
	fallbackCacheTTL = 40 * time.Millisecond
	t.Cleanup(func() {
		minCacheTTL, maxCacheTTL, fallbackCacheTTL = origMin, origMax, origFallback
	})
}

func TestResolveHostnameResolvesManagedFlagAndOwner(t *testing.T) {
	newFakeTXT(t, map[string][]string{
		"app.example.com": {"\"heritage=external-dns,external-dns/owner=home,external-dns/resource=service/traefik/traefik-private\""},
	})

	app, _ := resolveHostname(t.Context(), defaultResolver, "app.example.com")
	if !app.Managed {
		t.Error("expected app.example.com to be managed")
	}
	if app.OwnerID != "home" {
		t.Errorf("expected owner id 'home', got %q", app.OwnerID)
	}

	unmanaged, _ := resolveHostname(t.Context(), defaultResolver, "unmanaged.example.com")
	if unmanaged.Managed {
		t.Error("expected unmanaged.example.com to not be managed")
	}
	if unmanaged.OwnerID != "" {
		t.Errorf("expected no owner id for unmanaged.example.com, got %q", unmanaged.OwnerID)
	}
}

func TestResolveHostnameFallsBackToRecordTypePrefixedTXT(t *testing.T) {
	// Mirrors a real external-dns registry layout: a hostname with both A and
	// AAAA endpoints gets its ownership claim written as a-<name>/aaaa-<name>
	// TXT records instead of a bare-name one, to avoid ambiguity about which
	// RRset it covers.
	newFakeTXT(t, map[string][]string{
		"aaaa-multi.example.com": {"heritage=external-dns,external-dns/owner=home.alaunstras.se-external-dns-public"},
	})

	got, _ := resolveHostname(t.Context(), defaultResolver, "multi.example.com")
	if !got.Managed {
		t.Error("expected multi.example.com to be managed via the aaaa- prefixed TXT record")
	}
	if got.OwnerID != "home.alaunstras.se-external-dns-public" {
		t.Errorf("unexpected owner id: %q", got.OwnerID)
	}
}

func TestResolveHostnameResolvesAddresses(t *testing.T) {
	// Exercises resolveHostname directly (bypassing the cache) so this test
	// can't be polluted by another test's cached result for the same
	// (resolver, hostname) key.
	newFakeTXT(t, map[string][]string{
		"addr-test.example.com": {"heritage=external-dns,external-dns/owner=home"},
	})
	originalHost := lookupHost
	lookupHost = func(_ context.Context, resolver, name string) ([]string, error) {
		if name == "addr-test.example.com" {
			return []string{"203.0.113.10", "2001:db8::1"}, nil
		}
		return nil, nil
	}
	t.Cleanup(func() { lookupHost = originalHost })

	got, _ := resolveHostname(t.Context(), defaultResolver, "addr-test.example.com")
	want := []string{"203.0.113.10", "2001:db8::1"}
	if len(got.Addresses) != len(want) {
		t.Fatalf("expected addresses %v, got %v", want, got.Addresses)
	}
	for i, addr := range want {
		if got.Addresses[i] != addr {
			t.Errorf("expected addresses %v, got %v", want, got.Addresses)
			break
		}
	}
}

// lookupRequest issues a GET /v1/lookup for the given hostnames (and, when
// non-empty, resolver) the way bridge's plugin proxy reaches it in
// production: against the bare route, with every argument in the query
// string and each hostname as its own repeated "hostname" parameter.
func lookupRequest(t *testing.T, resolver string, hostnames ...string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/lookup", lookupHandler)

	query := url.Values{}
	for _, hostname := range hostnames {
		query.Add("hostname", hostname)
	}
	if resolver != "" {
		query.Set("resolver", resolver)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/lookup?"+query.Encode(), nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// decodeLookupResults decodes a /v1/lookup response body - a JSON object
// keyed by the requested hostname, see lookupHandler.
func decodeLookupResults(t *testing.T, rec *httptest.ResponseRecorder) map[string]HostnameResult {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var results map[string]HostnameResult
	if err := json.Unmarshal(rec.Body.Bytes(), &results); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	return results
}

// recordResolvers wraps whatever lookupTXT currently is (i.e. newFakeTXT's
// stub) to capture which resolver address each lookup was issued against.
// The returned func is safe to call while lookups are in flight, since a
// batch resolves its hostnames concurrently.
func recordResolvers(t *testing.T) func() []string {
	t.Helper()
	var mu sync.Mutex
	var seen []string
	wrapped := lookupTXT
	lookupTXT = func(ctx context.Context, resolver, name string) ([]string, error) {
		mu.Lock()
		seen = append(seen, resolver)
		mu.Unlock()
		return wrapped(ctx, resolver, name)
	}
	t.Cleanup(func() { lookupTXT = wrapped })

	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), seen...)
	}
}

func TestLookupHandlerAnswersEveryHostnameOfABatch(t *testing.T) {
	newFakeTXT(t, map[string][]string{
		"batch-a.example.com":      {"\"heritage=external-dns,external-dns/owner=home\""},
		"aaaa-batch-b.example.com": {"heritage=external-dns,external-dns/owner=public"},
	})

	results := decodeLookupResults(t, lookupRequest(t, "",
		"batch-a.example.com", "batch-b.example.com", "batch-c.example.com"))

	if len(results) != 3 {
		t.Fatalf("expected one entry per requested hostname, got %+v", results)
	}
	for hostname, result := range results {
		if result.Hostname != hostname {
			t.Errorf("entry keyed %q answers for %q", hostname, result.Hostname)
		}
	}
	if a := results["batch-a.example.com"]; !a.Managed || a.OwnerID != "home" {
		t.Errorf("unexpected result for batch-a.example.com: %+v", a)
	}
	// Claimed through its aaaa- prefixed registry record rather than the bare
	// name - the batch endpoint checks the same prefix variants per hostname.
	if b := results["batch-b.example.com"]; !b.Managed || b.OwnerID != "public" {
		t.Errorf("unexpected result for batch-b.example.com: %+v", b)
	}
	// No registry record at all: still present in the map, just not managed.
	if c := results["batch-c.example.com"]; c.Managed || c.OwnerID != "" {
		t.Errorf("expected batch-c.example.com to be unmanaged, got %+v", c)
	}
}

func TestLookupHandlerKeepsFailedHostnameInTheMap(t *testing.T) {
	newFakeTXT(t, map[string][]string{
		"ok-batch.example.com": {"heritage=external-dns,external-dns/owner=home"},
	})
	// Fail every lookup for one hostname of the batch (bare name and every
	// prefixed variant), leaving the fake's answers in place for the other.
	fake := lookupTXT
	lookupTXT = func(ctx context.Context, resolver, name string) ([]string, error) {
		if strings.HasSuffix(name, "broken-batch.example.com") {
			return nil, errors.New("SERVFAIL")
		}
		return fake(ctx, resolver, name)
	}
	t.Cleanup(func() { lookupTXT = fake })

	results := decodeLookupResults(t, lookupRequest(t, "",
		"ok-batch.example.com", "broken-batch.example.com"))

	broken, ok := results["broken-batch.example.com"]
	if !ok {
		t.Fatalf("expected the failed hostname to still have an entry, got %+v", results)
	}
	if broken.Error == "" {
		t.Errorf("expected the failed hostname's entry to report its error: %+v", broken)
	}
	if healthy := results["ok-batch.example.com"]; !healthy.Managed {
		t.Errorf("expected the rest of the batch to resolve normally: %+v", healthy)
	}
}

func TestLookupHandlerResolverQueryParameter(t *testing.T) {
	newFakeTXT(t, map[string][]string{})
	resolvers := recordResolvers(t)

	// An explicit resolver reaches the lookups verbatim; the "default"
	// sentinel and an omitted parameter both mean this backend's own
	// configured default. Each case uses its own hostname so none of them is
	// served from another's cache entry.
	cases := []struct {
		name     string
		resolver string
		hostname string
		want     string
	}{
		{name: "explicit override", resolver: "10.0.0.53:5353", hostname: "resolver-override.example.com", want: "10.0.0.53:5353"},
		{name: "default sentinel", resolver: defaultResolverSentinel, hostname: "resolver-sentinel.example.com", want: defaultResolver},
		{name: "omitted", resolver: "", hostname: "resolver-omitted.example.com", want: defaultResolver},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			before := len(resolvers())
			decodeLookupResults(t, lookupRequest(t, c.resolver, c.hostname))

			issued := resolvers()[before:]
			if len(issued) == 0 {
				t.Fatal("expected the request to issue at least one lookup")
			}
			for _, resolver := range issued {
				if resolver != c.want {
					t.Errorf("expected every lookup against %q, got %q", c.want, resolver)
				}
			}
		})
	}
}

func TestLookupHandlerRejectsMissingHostname(t *testing.T) {
	// No hostname parameter at all, an empty one, and a whitespace-only one
	// are all "no hostname was asked about" - there is nothing to key a
	// response map by, so none of them is a 200 with an empty object.
	cases := map[string][]string{
		"absent":          {},
		"empty":           {""},
		"whitespace only": {" "},
	}
	for name, hostnames := range cases {
		t.Run(name, func(t *testing.T) {
			rec := lookupRequest(t, "", hostnames...)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestLookupHandlerRejectsNonGET(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/lookup", lookupHandler)

	req := httptest.NewRequest(http.MethodPost, "/v1/lookup?hostname=app.example.com", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}
}

func TestCachedLookupHostnameServesFreshWithoutRefetching(t *testing.T) {
	withTinyCacheTTLs(t)
	f := newFakeTXT(t, map[string][]string{
		"cached.example.com": {"heritage=external-dns,external-dns/owner=home"},
	})

	for i := 0; i < 5; i++ {
		res := cachedLookupHostname(t.Context(), defaultResolver, "cached.example.com")
		if !res.Managed {
			t.Fatalf("call %d: expected managed", i)
		}
	}

	// All prefixes queried once on the first (uncached) call only; every
	// subsequent call within the fresh window must be served from cache.
	want := int32(len(txtRecordTypePrefixes()))
	if got := f.callCount(); got != want {
		t.Errorf("expected exactly %d upstream calls (one lookup), got %d", want, got)
	}
}

func TestCachedLookupHostnameRefreshesInBackgroundWhenStale(t *testing.T) {
	withTinyCacheTTLs(t)
	f := newFakeTXT(t, map[string][]string{
		"stale.example.com": {"heritage=external-dns,external-dns/owner=home"},
	})

	res := cachedLookupHostname(t.Context(), defaultResolver, "stale.example.com")
	if !res.Managed {
		t.Fatal("expected managed on first call")
	}
	firstCallCount := f.callCount()

	// fallbackCacheTTL is clamped to maxCacheTTL (40ms) by withTinyCacheTTLs.
	// Wait past its 50% stale threshold (20ms) but stay under the full 40ms
	// so the cached value is still what's returned.
	time.Sleep(25 * time.Millisecond)

	res = cachedLookupHostname(t.Context(), defaultResolver, "stale.example.com")
	if !res.Managed {
		t.Fatal("expected cached managed result while stale-refreshing")
	}

	// Background refresh was triggered - wait for it to land.
	deadline := time.Now().Add(2 * time.Second)
	for f.callCount() <= firstCallCount && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := f.callCount(); got <= firstCallCount {
		t.Errorf("expected a background refresh to have re-queried upstream, calls stayed at %d", got)
	}
}

// withFamilies temporarily overrides the enableIPv4/enableIPv6 toggles for
// the duration of a test.
func withFamilies(t *testing.T, ipv4, ipv6 bool) {
	t.Helper()
	origV4, origV6 := enableIPv4, enableIPv6
	enableIPv4, enableIPv6 = ipv4, ipv6
	t.Cleanup(func() { enableIPv4, enableIPv6 = origV4, origV6 })
}

func TestTXTRecordTypePrefixesRespectsFamilyToggles(t *testing.T) {
	cases := []struct {
		name       string
		ipv4, ipv6 bool
		want       []string
	}{
		{name: "both enabled", ipv4: true, ipv6: true, want: []string{"", "a-", "aaaa-", "cname-"}},
		{name: "ipv4 only", ipv4: true, ipv6: false, want: []string{"", "a-", "cname-"}},
		{name: "ipv6 only", ipv4: false, ipv6: true, want: []string{"", "aaaa-", "cname-"}},
		{name: "both disabled", ipv4: false, ipv6: false, want: []string{"", "cname-"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withFamilies(t, c.ipv4, c.ipv6)
			got := txtRecordTypePrefixes()
			if len(got) != len(c.want) {
				t.Fatalf("expected %v, got %v", c.want, got)
			}
			for i, p := range c.want {
				if got[i] != p {
					t.Errorf("expected %v, got %v", c.want, got)
					break
				}
			}
		})
	}
}

func TestLookupHostSkipsDisabledFamilies(t *testing.T) {
	// Uses the real lookupHost (not the fake harness) - with both families
	// disabled it must return immediately without attempting any DNS I/O,
	// so this is safe to run without network access.
	withFamilies(t, false, false)

	addrs, err := lookupHost(t.Context(), defaultResolver, "example.com")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(addrs) != 0 {
		t.Errorf("expected no addresses with both families disabled, got %v", addrs)
	}
}

func TestResolveHostnameSkipsPrefixForDisabledFamily(t *testing.T) {
	withFamilies(t, true, false) // IPv6 disabled

	var queried []string
	f := newFakeTXT(t, map[string][]string{
		"aaaa-family-test.example.com": {"heritage=external-dns,external-dns/owner=home"},
	})
	f.onQuery = func(name string) {
		queried = append(queried, name)
	}

	res, _ := resolveHostname(t.Context(), defaultResolver, "family-test.example.com")

	// The aaaa- prefixed TXT record IS the only one carrying a claim here,
	// but with IPv6 disabled it must never be queried, so this must report
	// unmanaged despite that record existing.
	if res.Managed {
		t.Error("expected unmanaged - the only claim record lives under a disabled family's prefix")
	}
	for _, name := range queried {
		if strings.HasPrefix(name, "aaaa-") {
			t.Errorf("expected aaaa- prefix to never be queried with IPv6 disabled, but got %q", name)
		}
	}
}
