import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';

import { CertCheckResults, CertCheckTarget, CertInspectResult, CertInspectTarget } from '../types';

// Must match pluginMetadata.name in plugin-manifest.ts - console proxies
// backend routes for a loaded dynamic plugin at /api/plugins/<name>/...
const CERTCHECK_PATH = '/api/plugins/cert-manager-console-plugin/api/v1/certcheck';
const CERTINSPECT_PATH = '/api/plugins/cert-manager-console-plugin/api/v1/certinspect';

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

// Ad-hoc single-target probe: performs a live TLS handshake against
// { protocol, host, port } and reports the certificate's subject/SAN/issuer/
// root common names, its validity window, and whether the endpoint
// requests or requires a client certificate (mTLS).
export const inspectCertificate = ({ protocol, host, port }: CertInspectTarget): Promise<CertInspectResult> => {
  const params = new URLSearchParams({ host });
  if (protocol) {
    params.set('protocol', protocol);
  }
  if (port) {
    params.set('port', String(port));
  }
  return consoleFetchJSON(`${CERTINSPECT_PATH}?${params.toString()}`);
};
