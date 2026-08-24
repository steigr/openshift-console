import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

export type Condition = {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
};

// --- cert-manager.io -------------------------------------------------------

export type IssuerRef = {
  name?: string;
  kind?: string;
  group?: string;
};

export type CertificateKind = K8sResourceCommon & {
  spec?: {
    secretName?: string;
    issuerRef?: IssuerRef;
    dnsNames?: string[];
    duration?: string;
    renewBefore?: string;
  };
  status?: {
    conditions?: Condition[];
    notAfter?: string;
    notBefore?: string;
    renewalTime?: string;
  };
};

export type CertificateRequestKind = K8sResourceCommon & {
  spec?: {
    issuerRef?: IssuerRef;
    duration?: string;
  };
  status?: {
    conditions?: Condition[];
  };
};

// Any of the provider keys under spec (acme/ca/vault/selfSigned/venafi) - we
// only care about which single key is set, not its full shape.
export type IssuerKind = K8sResourceCommon & {
  spec?: Record<string, unknown>;
  status?: {
    conditions?: Condition[];
  };
};

// --- acme.cert-manager.io ---------------------------------------------------

export type OrderKind = K8sResourceCommon & {
  spec?: {
    issuerRef?: IssuerRef;
    dnsNames?: string[];
  };
  status?: {
    state?: string;
    reason?: string;
  };
};

export type ChallengeKind = K8sResourceCommon & {
  spec?: {
    type?: string;
    dnsName?: string;
  };
  status?: {
    state?: string;
    reason?: string;
  };
};

// --- trust.cert-manager.io --------------------------------------------------

export type BundleTarget = {
  configMap?: { key?: string };
  secret?: { key?: string };
  namespaceSelector?: { matchLabels?: Record<string, string> };
};

export type BundleKind = K8sResourceCommon & {
  spec?: {
    sources?: unknown[];
    target?: BundleTarget;
  };
  status?: {
    conditions?: Condition[];
  };
};

// --- backend certcheck API ---------------------------------------------------

export type CertChainEntry = {
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  isCA: boolean;
  keyAlgorithm: string;
  keySize?: number;
  keyCurve?: string;
};

// One address family's independent view of a hostname:port target - only
// present in CertCheckResult.families, and only when the two families'
// results actually differ (one didn't connect, or both connected but
// presented different certificates).
export type FamilyCertResult = {
  family: 'IPv4' | 'IPv6';
  connected: boolean;
  subject?: string;
  issuer?: string;
  rootCA?: string;
  notBefore?: string;
  notAfter?: string;
  expiresInSeconds?: number;
  expired?: boolean;
  keyAlgorithm?: string;
  keySize?: number;
  keyCurve?: string;
  chainLength?: number;
  error?: string;
};

export type CertCheckResult = {
  hostname: string;
  port: number;
  subject?: string;
  issuer?: string;
  rootCA?: string;
  notBefore?: string;
  notAfter?: string;
  expiresInSeconds?: number;
  expired?: boolean;
  keyAlgorithm?: string;
  keySize?: number;
  keyCurve?: string;
  chainLength?: number;
  chain?: CertChainEntry[];
  // ipv4Connected/ipv6Connected always reflect whether a TLS handshake
  // succeeded over that family - this is what the IPv4/IPv6 badges are
  // driven by. familiesDiffer/families are populated only when there's a
  // real difference to show (see FamilyCertResult's doc comment); when the
  // families agree, the fields above already carry the single shared view.
  ipv4Connected: boolean;
  ipv6Connected: boolean;
  familiesDiffer?: boolean;
  families?: FamilyCertResult[];
  error?: string;
};

// --- backend certinfo API ----------------------------------------------------

// One hostname's live TLS certificate state, tagged with the resource it
// came from. A resource with N hostnames produces N entries; a
// namespace/cluster listing (no `name` in the request) produces one batch
// of these per matching object.
export type ResourceCertResult = CertCheckResult & {
  kind: string;
  namespace?: string;
  name: string;
  resourceError?: string;
};

// GVK plus an optional namespace and name: name given -> a single object,
// namespace only -> every matching object in that namespace, neither ->
// every matching object across the cluster.
export type CertInfoTarget = {
  group: string;
  version: string;
  kind: string;
  namespace?: string;
  name?: string;
};

// --- backend certinspect API -------------------------------------------------

export type ClientAuthRequirement = 'Off' | 'Optional' | 'mTLS';

export type CertInspectResult = {
  protocol: string;
  hostname: string;
  port: number;
  subjectCommonName?: string;
  sanEntries?: string[];
  issuerCommonName?: string;
  rootCommonName?: string;
  notBefore?: string;
  notAfter?: string;
  clientAuth?: ClientAuthRequirement;
  error?: string;
};

export type CertInspectTarget = {
  protocol?: string;
  host: string;
  port?: number;
};
