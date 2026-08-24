import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';

import { CertCheckResults, CertCheckTarget, CertInspectResult, CertInspectTarget } from '../types';

// Must match pluginMetadata.name in plugin-manifest.ts - console proxies
// backend routes for a loaded dynamic plugin at /api/plugins/<name>/...
const CERTCHECK_PATH = '/api/plugins/cert-manager-console-plugin/api/v1/certcheck';
const CERTINSPECT_PATH = '/api/plugins/cert-manager-console-plugin/api/v1/certinspect';

// Uses GET (repeated ?target=host:port params, handled by certCheckHandler
// in api/certcheck.go) rather than POST - a POST body was seen being
// dropped somewhere upstream of this backend (proxy/ingress), so GET is the
// only reliable transport here even though it's a batched, read-only query.
export const checkCertificates = (
  targets: CertCheckTarget[],
): Promise<CertCheckResults> => {
  const unique = Array.from(
    new Map(targets.filter((t) => t.hostname).map((t) => [`${t.hostname}:${t.port || 443}`, t])).values(),
  );
  if (unique.length === 0) {
    return Promise.resolve({});
  }
  const params = new URLSearchParams();
  unique.forEach((t) => params.append('target', `${t.hostname}:${t.port || 443}`));
  return consoleFetchJSON(`${CERTCHECK_PATH}?${params.toString()}`);
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
