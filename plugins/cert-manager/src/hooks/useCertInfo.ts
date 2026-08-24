import * as React from 'react';

import { fetchCertInfo } from '../api/certLookup';
import { CertInfoTarget, ResourceCertResult } from '../types';

// Fetches the live TLS certificate state for the resource(s) matching
// `target` (see api/certLookup.ts's fetchCertInfo) and re-runs whenever the
// target changes. `target` may be undefined while the owning object hasn't
// loaded yet (e.g. a horizontalNav tab's `obj` prop before the watch
// resolves) - the fetch is skipped until it's available.
export const useCertInfo = (
  target: CertInfoTarget | undefined,
): [ResourceCertResult[], boolean] => {
  const [results, setResults] = React.useState<ResourceCertResult[]>([]);
  const [loading, setLoading] = React.useState(false);

  const key = target ? JSON.stringify(target) : '';

  React.useEffect(() => {
    if (!target) {
      setResults([]);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    fetchCertInfo(target)
      .then((res) => {
        if (!cancelled) {
          setResults(res);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResults([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return [results, loading];
};
