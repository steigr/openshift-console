import * as React from 'react';

import { fetchDNSSettings, mapWithConcurrency } from '../api/dnsLookup';
import { DNSSettingsResult } from '../types';

// Per the backend routes' own design (one hostname per request, no batched
// endpoint - see api/dnssettings.go), never more than this many dns-settings
// requests are in flight at once.
const MAX_CONCURRENT_REQUESTS = 10;

// Fetches the live "DNS Settings" view (registry ownership + every A/AAAA/
// CNAME record with its real TTL) for each of `hostnames`, capped at
// MAX_CONCURRENT_REQUESTS in flight, and re-runs whenever the hostname list
// changes.
export const useDNSSettings = (
  hostnames: string[],
): [Record<string, DNSSettingsResult>, boolean] => {
  const [results, setResults] = React.useState<Record<string, DNSSettingsResult>>({});
  const [loading, setLoading] = React.useState(false);

  const key = hostnames.join(',');

  React.useEffect(() => {
    if (hostnames.length === 0) {
      setResults({});
      return undefined;
    }
    let cancelled = false;
    setLoading(true);

    mapWithConcurrency(hostnames, MAX_CONCURRENT_REQUESTS, (hostname) => fetchDNSSettings(hostname)).then(
      (fetched) => {
        if (cancelled) {
          return;
        }
        const byHostname: Record<string, DNSSettingsResult> = {};
        fetched.forEach((result, i) => {
          if (result) {
            byHostname[hostnames[i]] = result;
          }
        });
        setResults(byHostname);
        setLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [results, loading];
};
