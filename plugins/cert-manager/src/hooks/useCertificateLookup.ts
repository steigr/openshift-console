import * as React from 'react';

import { checkCertificates } from '../api/certLookup';
import { CertCheckResults, CertCheckTarget } from '../types';

const targetKey = (t: CertCheckTarget) => `${t.hostname}:${t.port || 443}`;

// Batches a REST TLS-certificate check for a set of hostname/port targets
// (see api/certLookup.ts) and re-runs whenever the requested target set
// changes.
export const useCertificateLookup = (
  targets: CertCheckTarget[],
): [CertCheckResults, boolean] => {
  const [results, setResults] = React.useState<CertCheckResults>({});
  const [loading, setLoading] = React.useState(false);

  const key = React.useMemo(
    () => Array.from(new Set(targets.map(targetKey))).sort().join(','),
    [targets],
  );

  React.useEffect(() => {
    if (!key) {
      setResults({});
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    const uniqueTargets = key.split(',').map((k) => {
      const idx = k.lastIndexOf(':');
      return { hostname: k.slice(0, idx), port: Number(k.slice(idx + 1)) };
    });
    checkCertificates(uniqueTargets)
      .then((res) => {
        if (!cancelled) {
          setResults(res);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResults({});
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
