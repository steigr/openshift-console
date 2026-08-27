import * as React from 'react';

import { fetchHostnameStatus, mapWithConcurrency } from '../api/dnsLookup';
import { HostnameResult } from '../types';

// Per the backend route's own design (one hostname per request, no batched
// endpoint - see api/lookup.go), never more than this many inspect requests
// are in flight at once, regardless of how many rows a list is showing.
const MAX_CONCURRENT_REQUESTS = 10;

// Fetches the live external-dns registry status for each of `hostnames`,
// capped at MAX_CONCURRENT_REQUESTS in flight, and re-runs whenever the
// hostname list changes. Used by DNSEndpointList's live-status column - kept
// separate from the reconciliation-based "Managed" column, since a
// DNSEndpoint's targets are frequently on a private/split-horizon zone this
// backend's resolver can't see (see lists/index.tsx's isReconciled doc
// comment).
export const useHostnameStatuses = (
  hostnames: string[],
): [Record<string, HostnameResult>, boolean] => {
  const [results, setResults] = React.useState<Record<string, HostnameResult>>({});
  const [loading, setLoading] = React.useState(false);

  const key = hostnames.join(',');

  React.useEffect(() => {
    if (hostnames.length === 0) {
      setResults({});
      return undefined;
    }
    let cancelled = false;
    setLoading(true);

    mapWithConcurrency(hostnames, MAX_CONCURRENT_REQUESTS, (hostname) => fetchHostnameStatus(hostname)).then(
      (fetched) => {
        if (cancelled) {
          return;
        }
        const byHostname: Record<string, HostnameResult> = {};
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
