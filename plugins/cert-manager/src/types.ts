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

// --- resources this plugin enriches but does not own -------------------------

export type IngressKind = K8sResourceCommon & {
  spec?: {
    rules?: { host?: string }[];
    tls?: { hosts?: string[]; secretName?: string }[];
  };
};

export type ServiceKind = K8sResourceCommon & {
  spec?: {
    type?: string;
  };
  status?: {
    loadBalancer?: {
      ingress?: { hostname?: string; ip?: string }[];
    };
  };
};

export type HTTPRouteKind = K8sResourceCommon & {
  spec?: {
    hostnames?: string[];
  };
};

export type TLSRouteKind = K8sResourceCommon & {
  spec?: {
    hostnames?: string[];
  };
};

export type GRPCRouteKind = K8sResourceCommon & {
  spec?: {
    hostnames?: string[];
  };
};

export type DNSEndpointEntry = {
  dnsName?: string;
  recordType?: string;
  targets?: string[];
};

export type DNSEndpointKind = K8sResourceCommon & {
  spec?: {
    endpoints?: DNSEndpointEntry[];
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
  error?: string;
};

export type CertCheckResults = Record<string, CertCheckResult>;

export type CertCheckTarget = {
  hostname: string;
  port?: number;
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
