import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';

import { CertCheckResults, CertCheckTarget } from '../types';

// Must match pluginMetadata.name in plugin-manifest.ts - console proxies
// backend routes for a loaded dynamic plugin at /api/plugins/<name>/...
const CERTCHECK_PATH = '/api/plugins/cert-manager-console-plugin/api/v1/certcheck';

export const checkCertificates = (
  targets: CertCheckTarget[],
): Promise<CertCheckResults> => {
  const unique = Array.from(
    new Map(targets.filter((t) => t.hostname).map((t) => [`${t.hostname}:${t.port || 443}`, t])).values(),
  );
  if (unique.length === 0) {
    return Promise.resolve({});
  }
  return consoleFetchJSON.post(CERTCHECK_PATH, { targets: unique });
};
