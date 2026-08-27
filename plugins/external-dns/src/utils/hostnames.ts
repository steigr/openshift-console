import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

// Derives the hostname(s) a resource is meant to be reachable on, so the
// "DNS Settings" tab (and DNSEndpointList's live-status column) know what to
// look up - one function per kind this plugin knows how to enrich, mirroring
// cert-manager's Go-side hostnamesForIngressObj/hostnamesForServiceObj/etc
// (api/certinfo.go) and the console-core "DNS" column's own
// getCandidateHostnames (patches/0015-external-dns-column.patch), since that
// derivation only ever happens client-side here (this plugin has no backend
// k8s client - see api/lookup.go's doc comments).

const uniq = (hosts: (string | undefined)[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hosts) {
    if (!h || seen.has(h)) {
      continue;
    }
    seen.add(h);
    out.push(h);
  }
  return out;
};

const HOSTNAME_ANNOTATION = 'external-dns.alpha.kubernetes.io/hostname';
const INTERNAL_HOSTNAME_ANNOTATION = 'external-dns.alpha.kubernetes.io/internal-hostname';
const EXCLUDE_ANNOTATION = 'external-dns.alpha.kubernetes.io/exclude';

const splitAnnotationHostnames = (value: string): string[] =>
  value
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

// Reads external-dns' hostname/internal-hostname annotations off obj -
// present on any kind external-dns can create records for by annotation
// alone (Node included, for its on-prem/bare-metal source), not just kinds
// with a structural hostname field of their own. `excluded` mirrors
// external-dns.alpha.kubernetes.io/exclude=true: obj is never DNS-managed
// regardless of any other signal.
const annotationHostnames = (obj: K8sResourceCommon): { hosts: string[]; excluded: boolean } => {
  const annotations = obj.metadata?.annotations || {};
  if (annotations[EXCLUDE_ANNOTATION] === 'true') {
    return { hosts: [], excluded: true };
  }
  return {
    hosts: [
      ...(annotations[HOSTNAME_ANNOTATION] ? splitAnnotationHostnames(annotations[HOSTNAME_ANNOTATION]) : []),
      ...(annotations[INTERNAL_HOSTNAME_ANNOTATION]
        ? splitAnnotationHostnames(annotations[INTERNAL_HOSTNAME_ANNOTATION])
        : []),
    ],
    excluded: false,
  };
};

// Merges a kind's own structural hostname(s) with its annotation-derived
// ones, honoring `exclude` (obj opts out of DNS management entirely, even
// if it has structural hostnames).
const withAnnotations = (structuralHosts: (string | undefined)[], obj: K8sResourceCommon): string[] => {
  const { hosts: annotationHosts, excluded } = annotationHostnames(obj);
  if (excluded) {
    return [];
  }
  return uniq([...structuralHosts, ...annotationHosts]);
};

type IngressLike = K8sResourceCommon & {
  spec?: {
    rules?: { host?: string }[];
    tls?: { hosts?: string[] }[];
  };
};

export const hostnamesForIngress = (obj: IngressLike): string[] =>
  withAnnotations(
    [
      ...(obj.spec?.rules || []).map((rule) => rule.host),
      ...(obj.spec?.tls || []).flatMap((tls) => tls.hosts || []),
    ],
    obj,
  );

type ServiceLike = K8sResourceCommon & {
  status?: {
    loadBalancer?: {
      ingress?: { hostname?: string; ip?: string }[];
    };
  };
};

export const hostnamesForService = (obj: ServiceLike): string[] =>
  withAnnotations(
    (obj.status?.loadBalancer?.ingress || []).map((ing) => ing.hostname || ing.ip),
    obj,
  );

type RouteLike = K8sResourceCommon & {
  spec?: {
    hostnames?: string[];
  };
};

// Shared by HTTPRoute/TLSRoute/GRPCRoute - all three carry the same
// spec.hostnames shape.
export const hostnamesForRoute = (obj: RouteLike): string[] => withAnnotations(obj.spec?.hostnames || [], obj);

// TCPRoute/UDPRoute have no spec.hostnames field at all (pure L4
// forwarding, no Host/SNI-based routing) - their only hostname source is
// the external-dns annotations.
export const hostnamesForTCPOrUDPRoute = (obj: K8sResourceCommon): string[] => withAnnotations([], obj);

// A bare Node has no hostname field of its own either - external-dns' node
// source relies entirely on the external-dns.alpha.kubernetes.io/hostname
// annotation (typical for bare-metal/on-prem clusters).
export const hostnamesForNode = (obj: K8sResourceCommon): string[] => withAnnotations([], obj);

type DNSEndpointLike = K8sResourceCommon & {
  spec?: {
    endpoints?: { dnsName?: string }[];
  };
};

// DNSEndpoint IS external-dns' own desired-state object - its hostnames
// come straight from spec.endpoints, never from annotations.
export const hostnamesForDNSEndpoint = (obj: DNSEndpointLike): string[] =>
  uniq((obj.spec?.endpoints || []).map((ep) => ep.dnsName));
