import {
  DNSEndpointKind,
  GRPCRouteKind,
  HTTPRouteKind,
  IngressKind,
  ServiceKind,
  TLSRouteKind,
} from '../types';

const uniq = (values: (string | undefined)[]): string[] =>
  Array.from(new Set(values.filter((v): v is string => !!v)));

export const hostnamesForIngress = (obj: IngressKind): string[] =>
  uniq([
    ...(obj.spec?.rules || []).map((r) => r.host),
    ...(obj.spec?.tls || []).flatMap((t) => t.hosts || []),
  ]);

export const hostnamesForHTTPRoute = (obj: HTTPRouteKind): string[] =>
  uniq(obj.spec?.hostnames || []);

export const hostnamesForTLSRoute = (obj: TLSRouteKind): string[] =>
  uniq(obj.spec?.hostnames || []);

export const hostnamesForGRPCRoute = (obj: GRPCRouteKind): string[] =>
  uniq(obj.spec?.hostnames || []);

export const hostnamesForService = (obj: ServiceKind): string[] =>
  uniq(
    (obj.status?.loadBalancer?.ingress || []).map((ing) => ing.hostname || ing.ip),
  );

export const hostnamesForDNSEndpoint = (obj: DNSEndpointKind): string[] =>
  uniq((obj.spec?.endpoints || []).map((ep) => ep.dnsName));
