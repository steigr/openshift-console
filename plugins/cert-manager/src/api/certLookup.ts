import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';

import { CertInfoTarget, CertInspectResult, CertInspectTarget, ResourceCertResult } from '../types';

// Must match pluginMetadata.name in plugin-manifest.ts - console proxies
// backend routes for a loaded dynamic plugin at /api/plugins/<name>/...
const CERTINFO_PATH = '/api/plugins/cert-manager-console-plugin/api/v1/certinfo';
const CERTINSPECT_PATH = '/api/plugins/cert-manager-console-plugin/api/v1/certinspect';
const INSPECT_RESOURCE_PATH = '/api/plugins/cert-manager-console-plugin/api/v1/inspect/ns';

// Console's bridge proxy for plugin backend routes (pkg/plugins/handlers.go)
// only ever issues a bare GET to the backend and drops the original
// request's query string entirely - it forwards the path alone. So the
// payload has to travel as a base64url-encoded JSON path segment instead of
// a query string; api/certcheck.go and api/certinspect.go decode it the
// same way (see their init() doc comments - this bit them silently once
// already: a query-string request returns 200 with an empty/useless body,
// not an error, because the backend just sees no params at all).
const toBase64Url = (value: unknown): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// Fetches the resource(s) matching `target` from the cluster (via the
// backend's own ServiceAccount, api/k8sclient.go) and returns the live TLS
// certificate state of each hostname the backend derives from them -
// target.name given -> that one object, namespace only -> every matching
// object in that namespace, neither -> every matching object cluster-wide.
export const fetchCertInfo = (target: CertInfoTarget): Promise<ResourceCertResult[]> => {
  const payload = toBase64Url(target);
  return consoleFetchJSON(`${CERTINFO_PATH}/${payload}`);
};

// Ad-hoc single-target probe: performs a live TLS handshake against
// { protocol, host, port } and reports the certificate's subject/SAN/issuer/
// root common names, its validity window, and whether the endpoint
// requests or requires a client certificate (mTLS).
export const inspectCertificate = ({ protocol, host, port }: CertInspectTarget): Promise<CertInspectResult> => {
  const payload = toBase64Url({ protocol, host, port });
  return consoleFetchJSON(`${CERTINSPECT_PATH}/${payload}`);
};

// Fetches the live TLS certificate state for a single named resource, the
// same way fetchCertInfo does, but as a plain, human-readable REST-style GET
// (.../inspect/ns/<namespace>/<group>~<version>~<kind>/<name>) instead of
// one opaque base64url-encoded payload segment. group is empty for the core
// API group (e.g. "~v1~Service") - see api/certinfo.go's parseGVKPath.
export const fetchInspectResource = ({
  group,
  version,
  kind,
  namespace,
  name,
}: Required<CertInfoTarget>): Promise<ResourceCertResult[]> => {
  const gvk = `${group}~${version}~${kind}`;
  return consoleFetchJSON(
    `${INSPECT_RESOURCE_PATH}/${encodeURIComponent(namespace)}/${gvk}/${encodeURIComponent(name)}`,
  );
};
