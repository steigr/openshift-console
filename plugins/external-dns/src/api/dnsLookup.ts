import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';

import { DNSSettingsResult, HostnameResult, HostnameResults } from '../types';
import { consolePath } from '../utils/consolePath';

// Console proxies a ConsolePlugin's declared proxy alias at
// /api/proxy/plugin/<plugin-name>/<alias>/<rest>: it strips that whole prefix
// and forwards "/<rest>" to the plugin's own Service with the request's
// method, query string and body intact. <plugin-name> must match
// pluginMetadata.name in plugin-manifest.ts and <alias> the
// spec.proxy[].alias in charts/console-external-dns-plugin/templates/
// consoleplugin.yaml. consolePath() puts console's own base path in front, so
// these still resolve when console isn't served at "/".
const PROXY_PATH = '/api/proxy/plugin/external-dns-console-plugin/api';
const LOOKUP_PATH = `${PROXY_PATH}/v1/lookup`;
const DNS_SETTINGS_PATH = `${PROXY_PATH}/v1/dns-settings`;

// Both routes take their arguments as ordinary query parameters, each
// hostname as its own repeated `hostname` parameter. They used to encode
// those as path segments instead, because the plugin-asset route this backend
// was reached through before (/api/plugins/<name>/...) is a bare GET that
// drops the query string entirely - the proxy route above keeps it, so
// nothing has to be smuggled through the path any more. An omitted `resolver`
// means the backend's own configured default (it also still accepts the
// literal "default" - see api/lookup.go's defaultResolverSentinel).
const hostnameQuery = (hostnames: string[], resolver?: string): string => {
  const params = new URLSearchParams();
  hostnames.forEach((hostname) => params.append('hostname', hostname));
  if (resolver) {
    params.set('resolver', resolver);
  }
  return params.toString();
};

// Cached registry-ownership check for a batch of hostnames: the response is
// an object keyed by the hostname asked about, with an entry for every one of
// them - a hostname whose lookup failed carries its error rather than going
// missing (see api/lookup.go's lookupHandler).
export const fetchHostnameStatuses = (
  hostnames: string[],
  resolver?: string,
): Promise<HostnameResults> =>
  consoleFetchJSON(consolePath(`${LOOKUP_PATH}?${hostnameQuery(hostnames, resolver)}`));

// One hostname's registry status - backs the DNSEndpointList's live-status
// column. There is a single lookup endpoint and it is the batched one, so
// this asks about a one-hostname batch and reads that key back out;
// undefined means the backend answered without an entry for it.
export const fetchHostnameStatus = (
  hostname: string,
  resolver?: string,
): Promise<HostnameResult | undefined> =>
  fetchHostnameStatuses([hostname], resolver).then((results) => results?.[hostname]);

// Full "DNS Settings" view for one hostname - backs the DNS Settings tab.
// Single-hostname by design on the backend side too (see api/dnssettings.go).
export const fetchDNSSettings = (hostname: string, resolver?: string): Promise<DNSSettingsResult> =>
  consoleFetchJSON(consolePath(`${DNS_SETTINGS_PATH}?${hostnameQuery([hostname], resolver)}`));

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
