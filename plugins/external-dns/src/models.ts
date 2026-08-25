export type ExternalDNSModel = {
  group: string;
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
  label: string;
  labelPlural: string;
  abbr: string;
  id: string;
};

export const DNSEndpointModel: ExternalDNSModel = {
  group: 'externaldns.k8s.io',
  version: 'v1alpha1',
  kind: 'DNSEndpoint',
  plural: 'dnsendpoints',
  namespaced: true,
  label: 'DNSEndpoint',
  labelPlural: 'DNSEndpoints',
  abbr: 'DE',
  id: 'dnsendpoint',
};

export const referenceForModel = (model: ExternalDNSModel): string =>
  `${model.group}~${model.version}~${model.kind}`;
