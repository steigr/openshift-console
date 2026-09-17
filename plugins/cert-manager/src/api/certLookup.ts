import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';

import { CertInfoTarget, CertInspectResult, CertInspectTarget, ResourceCertResult } from '../types';
import { consolePath } from '../utils/consolePath';

// Console proxies /api/proxy/plugin/<consolePluginName>/<alias>/... to this
// plugin's backend Service, stripping everything up to and including the
// alias - so the backend sees the "/v1/..." suffix alone. <consolePluginName>
// must match pluginMetadata.name in plugin-manifest.ts, and the alias must
// match the chart's ConsolePlugin spec.proxy[].alias / the console chart's
// plugins[].proxy.alias ("api"). Unlike the plugin-asset route
// (/api/plugins/<name>/...), this one forwards the request's method, query
// string and body untouched, and - with authorization: UserToken - the
// logged-in user's own credentials, which is what the backend authorizes its
// API server reads with. consolePath prefixes console's own base path.
const API_BASE = '/api/proxy/plugin/cert-manager-console-plugin/api/v1';
const CERTINSPECT_PATH = `${API_BASE}/certinspect`;
const INSPECT_RESOURCE_PATH = `${API_BASE}/inspect/ns`;

// The {namespace} path segment a caller passes for a cluster-scoped kind
// (currently only Node) - must match api/certinfo.go's clusterScopedSegment.
export const CLUSTER_SCOPED_SEGMENT = '-';

// Ad-hoc single-target probe: performs a live TLS handshake against
// { protocol, host, port } and reports the certificate's subject/SAN/issuer/
// root common names, its validity window, and whether the endpoint
// requests or requires a client certificate (mTLS). protocol and port are
// omitted when unset, leaving the backend's own defaults (tcp/443) to apply.
export const inspectCertificate = ({ protocol, host, port }: CertInspectTarget): Promise<CertInspectResult> => {
  const params = new URLSearchParams({ host });
  if (protocol) {
    params.set('protocol', protocol);
  }
  if (port) {
    params.set('port', String(port));
  }
  return consoleFetchJSON(consolePath(`${CERTINSPECT_PATH}?${params.toString()}`));
};

// Fetches the live TLS certificate state for a single named resource: a
// plain, human-readable REST-style GET
// (.../inspect/ns/<namespace>/<group>~<version>~<kind>/<name>). group is
// empty for the core API group (e.g. "~v1~Service") - see
// api/certinfo.go's parseGVKPath. Listing several resources (e.g. a list
// view) is the caller's job: issue one request per resource, concurrency-
// limited client-side (e.g. 10 in flight).
export const fetchInspectResource = ({
  group,
  version,
  kind,
  namespace,
  name,
}: Required<CertInfoTarget>): Promise<ResourceCertResult[]> => {
  const gvk = `${group}~${version}~${kind}`;
  return consoleFetchJSON(
    consolePath(`${INSPECT_RESOURCE_PATH}/${encodeURIComponent(namespace)}/${gvk}/${encodeURIComponent(name)}`),
  );
};
