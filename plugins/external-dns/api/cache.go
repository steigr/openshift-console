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

type cacheEntry struct {
	result    HostnameResult
	ttl       time.Duration
	fetchedAt time.Time
}

func (e *cacheEntry) age() time.Duration {
	return time.Since(e.fetchedAt)
}

func (e *cacheEntry) expired() bool {
	return e.age() >= e.ttl
}

func (e *cacheEntry) stale() bool {
	return time.Duration(float64(e.age())) >= time.Duration(float64(e.ttl)*staleFraction)
}

type resultCache struct {
	mu      sync.RWMutex
	entries map[string]*cacheEntry
	// refreshing prevents piling up duplicate background refreshes for the
	// same key while one is already in flight.
	refreshing map[string]struct{}
}

var cache = &resultCache{
	entries:    make(map[string]*cacheEntry),
	refreshing: make(map[string]struct{}),
}

func cacheKey(resolver, hostname string) string {
	return resolver + "|" + hostname
}

func (c *resultCache) get(key string) (*cacheEntry, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.entries[key]
	return e, ok
}

func (c *resultCache) set(key string, e *cacheEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = e
}

// tryStartRefresh claims key for a background refresh, returning false if
// one is already in flight.
func (c *resultCache) tryStartRefresh(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, inFlight := c.refreshing[key]; inFlight {
		return false
	}
	c.refreshing[key] = struct{}{}
	return true
}

func (c *resultCache) endRefresh(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.refreshing, key)
}

// cachedLookupHostname wraps resolveHostname with the TTL-aware cache
// described above.
func cachedLookupHostname(ctx context.Context, resolver, hostname string) HostnameResult {
	key := cacheKey(resolver, hostname)

	if entry, ok := cache.get(key); ok && !entry.expired() {
		if entry.stale() {
			refreshInBackground(resolver, hostname, key)
		}
		return entry.result
	}

	result, ttl := resolveHostname(ctx, resolver, hostname)
	cache.set(key, &cacheEntry{result: result, ttl: ttl, fetchedAt: time.Now()})
	return result
}

// refreshInBackground re-resolves hostname without blocking the caller,
// detached from the triggering request's context since it must outlive the
// HTTP response that triggered it.
func refreshInBackground(resolver, hostname, key string) {
	if !cache.tryStartRefresh(key) {
		return
	}
	go func() {
		defer cache.endRefresh(key)
		ctx, cancel := context.WithTimeout(context.Background(), lookupTimeout)
		defer cancel()
		result, ttl := resolveHostname(ctx, resolver, hostname)
		cache.set(key, &cacheEntry{result: result, ttl: ttl, fetchedAt: time.Now()})
	}()
}
