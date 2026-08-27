import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';

import { DNSSettingsResult, HostnameResult } from '../types';

// Must match pluginMetadata.name in plugin-manifest.ts - console proxies
// backend routes for a loaded dynamic plugin at /api/plugins/<name>/...
const INSPECT_PATH = '/api/plugins/external-dns-console-plugin/api/v1/inspect';
const DNS_SETTINGS_PATH = '/api/plugins/external-dns-console-plugin/api/v1/dns-settings';

// The {resolver} path segment meaning "use the backend's configured default
// resolver" - see api/lookup.go's defaultResolverSegment.
const DEFAULT_RESOLVER_SEGMENT = 'default';

// Both backend routes are plain REST paths - a bare hostname is already a
// valid, readable path segment on its own (see api/lookup.go's and
// api/dnssettings.go's init() doc comments), so no payload encoding is
// needed here at all, unlike cert-manager's certLookup.ts.
const resolverSegment = (resolver?: string): string =>
  resolver ? encodeURIComponent(resolver) : DEFAULT_RESOLVER_SEGMENT;

// Lightweight, cached registry-ownership check for one hostname - backs the
// DNSEndpointList's live-status column.
export const fetchHostnameStatus = (hostname: string, resolver?: string): Promise<HostnameResult> =>
  consoleFetchJSON(`${INSPECT_PATH}/${resolverSegment(resolver)}/${encodeURIComponent(hostname)}`);

// Full "DNS Settings" view for one hostname - backs the DNS Settings tab.
export const fetchDNSSettings = (hostname: string, resolver?: string): Promise<DNSSettingsResult> =>
  consoleFetchJSON(`${DNS_SETTINGS_PATH}/${resolverSegment(resolver)}/${encodeURIComponent(hostname)}`);

// Runs fn over items with at most `limit` in flight at once - used so a
// list view enriching N rows (or a resource with N hostnames) never fires
// more than a handful of requests at the backend simultaneously. Each
// item's own success/failure is caught individually (mapWithConcurrency
// itself never rejects) so one bad hostname doesn't sink the rest.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) {
        return;
      }
      try {
        results[i] = await fn(items[i]);
      } catch {
        results[i] = undefined;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
