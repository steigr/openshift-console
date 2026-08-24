export type CertManagerModel = {
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

const CERT_MANAGER_GROUP = 'cert-manager.io';
const ACME_GROUP = 'acme.cert-manager.io';
const TRUST_MANAGER_GROUP = 'trust.cert-manager.io';

export const CertificateModel: CertManagerModel = {
  group: CERT_MANAGER_GROUP,
  version: 'v1',
  kind: 'Certificate',
  plural: 'certificates',
  namespaced: true,
  label: 'Certificate',
  labelPlural: 'Certificates',
  abbr: 'C',
  id: 'certificate',
};

export const CertificateRequestModel: CertManagerModel = {
  group: CERT_MANAGER_GROUP,
  version: 'v1',
  kind: 'CertificateRequest',
  plural: 'certificaterequests',
  namespaced: true,
  label: 'CertificateRequest',
  labelPlural: 'CertificateRequests',
  abbr: 'CR',
  id: 'certificaterequest',
};

export const IssuerModel: CertManagerModel = {
  group: CERT_MANAGER_GROUP,
  version: 'v1',
  kind: 'Issuer',
  plural: 'issuers',
  namespaced: true,
  label: 'Issuer',
  labelPlural: 'Issuers',
  abbr: 'I',
  id: 'issuer',
};

export const ClusterIssuerModel: CertManagerModel = {
  group: CERT_MANAGER_GROUP,
  version: 'v1',
  kind: 'ClusterIssuer',
  plural: 'clusterissuers',
  namespaced: false,
  label: 'ClusterIssuer',
  labelPlural: 'ClusterIssuers',
  abbr: 'CI',
  id: 'clusterissuer',
};

export const OrderModel: CertManagerModel = {
  group: ACME_GROUP,
  version: 'v1',
  kind: 'Order',
  plural: 'orders',
  namespaced: true,
  label: 'Order',
  labelPlural: 'Orders',
  abbr: 'O',
  id: 'order',
};

export const ChallengeModel: CertManagerModel = {
  group: ACME_GROUP,
  version: 'v1',
  kind: 'Challenge',
  plural: 'challenges',
  namespaced: true,
  label: 'Challenge',
  labelPlural: 'Challenges',
  abbr: 'CH',
  id: 'challenge',
};

export const BundleModel: CertManagerModel = {
  group: TRUST_MANAGER_GROUP,
  version: 'v1alpha1',
  kind: 'Bundle',
  plural: 'bundles',
  namespaced: false,
  label: 'Bundle',
  labelPlural: 'Bundles',
  abbr: 'B',
  id: 'bundle',
};

export const referenceForModel = (model: CertManagerModel): string =>
  `${model.group}~${model.version}~${model.kind}`;
