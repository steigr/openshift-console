package api

import (
	"context"
	"sync"
	"time"
)

// TTL-aware cache for resolveHostname results, so a page with N rows doesn't
// re-run the same TXT lookups on every render/poll. Follows the common stub
// resolver convention (systemd-resolved et al.): a cached entry is served
// as-is until half its TTL has elapsed, then served-stale-while-revalidating
// in the background until the full TTL expires, at which point a lookup
// blocks until fresh data is in.
// var, not const, so tests can shrink them to keep TTL-timing tests fast.
var (
	minCacheTTL      = 30 * time.Second // floor: never trust a TTL shorter than this
	maxCacheTTL      = 30 * time.Minute // ceiling: never cache longer than this even if TTL says so
	fallbackCacheTTL = 5 * time.Minute  // used when the transport can't report a real TTL (plain DNS) or nothing was found
	staleFraction    = 0.5              // fraction of TTL after which a background refresh kicks in
)

func clampCacheTTL(ttl time.Duration) time.Duration {
	if ttl < minCacheTTL {
		return minCacheTTL
	}
	if ttl > maxCacheTTL {
		return maxCacheTTL
	}
	return ttl
}

type cacheEntry[T any] struct {
	result    T
	ttl       time.Duration
	fetchedAt time.Time
}

func (e *cacheEntry[T]) age() time.Duration {
	return time.Since(e.fetchedAt)
}

func (e *cacheEntry[T]) expired() bool {
	return e.age() >= e.ttl
}

func (e *cacheEntry[T]) stale() bool {
	return time.Duration(float64(e.age())) >= time.Duration(float64(e.ttl)*staleFraction)
}

// resultCache is a generic TTL-aware cache, shared by cachedLookupHostname
// (HostnameResult, the registry-ownership check) and
// cachedResolveDNSSettings (DNSSettingsResult, the fuller per-record view -
// see dnssettings.go). Each gets its own instance, so a hostname's two
// cached shapes never collide despite sharing the same key format.
type resultCache[T any] struct {
	mu      sync.RWMutex
	entries map[string]*cacheEntry[T]
	// refreshing prevents piling up duplicate background refreshes for the
	// same key while one is already in flight.
	refreshing map[string]struct{}
}

func newResultCache[T any]() *resultCache[T] {
	return &resultCache[T]{
		entries:    make(map[string]*cacheEntry[T]),
		refreshing: make(map[string]struct{}),
	}
}

var cache = newResultCache[HostnameResult]()

func cacheKey(resolver, hostname string) string {
	return resolver + "|" + hostname
}

func (c *resultCache[T]) get(key string) (*cacheEntry[T], bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.entries[key]
	return e, ok
}

func (c *resultCache[T]) set(key string, e *cacheEntry[T]) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = e
}

// tryStartRefresh claims key for a background refresh, returning false if
// one is already in flight.
func (c *resultCache[T]) tryStartRefresh(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, inFlight := c.refreshing[key]; inFlight {
		return false
	}
	c.refreshing[key] = struct{}{}
	return true
}

func (c *resultCache[T]) endRefresh(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.refreshing, key)
}

// cachedFetch is the shared get-fresh-or-refresh-stale-in-background policy
// behind both cachedLookupHostname and cachedResolveDNSSettings: served from
// cache as-is until half its TTL has elapsed, then served-stale-while a
// background refresh runs, until the full TTL expires and a call blocks on
// a fresh fetch. skipCache bypasses all of this (see isInternalClusterResolver
// in dnssettings.go) - every call resolves fresh, and nothing is cached.
func cachedFetch[T any](ctx context.Context, c *resultCache[T], key string, skipCache bool, resolve func(context.Context) (T, time.Duration)) T {
	if skipCache {
		result, _ := resolve(ctx)
		return result
	}

	if entry, ok := c.get(key); ok && !entry.expired() {
		if entry.stale() {
			refreshInBackground(c, key, resolve)
		}
		return entry.result
	}

	result, ttl := resolve(ctx)
	c.set(key, &cacheEntry[T]{result: result, ttl: ttl, fetchedAt: time.Now()})
	return result
}

// cachedLookupHostname wraps resolveHostname with the TTL-aware cache
// described above.
func cachedLookupHostname(ctx context.Context, resolver, hostname string) HostnameResult {
	skip := isInternalClusterResolver(resolver)
	return cachedFetch(ctx, cache, cacheKey(resolver, hostname), skip, func(ctx context.Context) (HostnameResult, time.Duration) {
		return resolveHostname(ctx, resolver, hostname)
	})
}

// refreshInBackground re-resolves key without blocking the caller, detached
// from the triggering request's context since it must outlive the HTTP
// response that triggered it.
func refreshInBackground[T any](c *resultCache[T], key string, resolve func(context.Context) (T, time.Duration)) {
	if !c.tryStartRefresh(key) {
		return
	}
	go func() {
		defer c.endRefresh(key)
		ctx, cancel := context.WithTimeout(context.Background(), lookupTimeout)
		defer cancel()
		result, ttl := resolve(ctx)
		c.set(key, &cacheEntry[T]{result: result, ttl: ttl, fetchedAt: time.Now()})
	}()
}
