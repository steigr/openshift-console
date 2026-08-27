import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

// Derives the hostname(s) a resource is meant to be reachable on, so the
// "DNS Settings" tab knows what to look up - one function per kind this
// plugin knows how to enrich, mirroring cert-manager's Go-side
// hostnamesForIngressObj/hostnamesForServiceObj/etc (api/certinfo.go),
// since that lookup only ever happens client-side here (this plugin has no
// backend k8s client - see api/lookup.go's doc comments).

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

type IngressLike = K8sResourceCommon & {
  spec?: {
    rules?: { host?: string }[];
    tls?: { hosts?: string[] }[];
  };
};

export const hostnamesForIngress = (obj: IngressLike): string[] =>
  uniq([
    ...(obj.spec?.rules || []).map((rule) => rule.host),
    ...(obj.spec?.tls || []).flatMap((tls) => tls.hosts || []),
  ]);

type ServiceLike = K8sResourceCommon & {
  status?: {
    loadBalancer?: {
      ingress?: { hostname?: string; ip?: string }[];
    };
  };
};

export const hostnamesForService = (obj: ServiceLike): string[] =>
  uniq((obj.status?.loadBalancer?.ingress || []).map((ing) => ing.hostname || ing.ip));

type RouteLike = K8sResourceCommon & {
  spec?: {
    hostnames?: string[];
  };
};

// Shared by HTTPRoute/TLSRoute/GRPCRoute - all three carry the same
// spec.hostnames shape.
export const hostnamesForRoute = (obj: RouteLike): string[] => uniq(obj.spec?.hostnames || []);

type DNSEndpointLike = K8sResourceCommon & {
  spec?: {
    endpoints?: { dnsName?: string }[];
  };
};

export const hostnamesForDNSEndpoint = (obj: DNSEndpointLike): string[] =>
  uniq((obj.spec?.endpoints || []).map((ep) => ep.dnsName));
