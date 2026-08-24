import { EncodedExtension } from '@openshift/dynamic-plugin-sdk-webpack';
import {
  HorizontalNavTab,
  ModelFeatureFlag,
  NavSection,
  ResourceClusterNavItem,
  ResourceListPage,
  ResourceNSNavItem,
  Separator,
} from '@openshift-console/dynamic-plugin-sdk';
import { ConsolePluginBuildMetadata } from '@openshift-console/dynamic-plugin-sdk-webpack/lib/build-types';

import {
  BundleModel,
  CertManagerModel,
  ChallengeModel,
  CertificateModel,
  CertificateRequestModel,
  ClusterIssuerModel,
  IssuerModel,
  OrderModel,
} from './src/models';

export const pluginMetadata: ConsolePluginBuildMetadata = {
  dependencies: {
    '@console/pluginAPI': '*',
  },
  description:
    'Adds navigation and list views for cert-manager.io/acme.cert-manager.io/trust.cert-manager.io ' +
    'resources, and enriches Ingress, Service, HTTPRoute, TLSRoute, GRPCRoute and DNSEndpoint pages with the ' +
    'live TLS certificate actually being served on their hostnames.',
  displayName: 'Cert Manager console plugin',
  exposedModules: {
    lists: './components/lists/index.tsx',
    tabs: './components/tabs/CertificateTab.tsx',
  },
  name: 'cert-manager-console-plugin',
  version: '0.0.1',
};

const CERT_MANAGER_SECTION_ID = 'cert-manager';
const TRUST_MANAGER_SECTION_ID = 'trust-manager';

// Gates the DNSEndpoint enrichment tab so this plugin degrades gracefully
// when the externaldns.k8s.io CRD (and therefore external-dns) is not
// installed on the cluster - the flag is only set when Console can resolve
// the DNSEndpoint model.
const DNS_ENDPOINT_FLAG = 'CERT_MANAGER_DNS_ENDPOINT';

// Gates the entire "Cert Manager" nav group (section, nav items, and list
// pages) so it only appears once the cert-manager.io CRDs are actually
// installed - set when Console can resolve the Certificate model.
const CERT_MANAGER_FLAG = 'CERT_MANAGER';

const navSection = (
  id: string,
  name: string,
  insertBefore?: string,
  requiredFlag?: string,
): EncodedExtension<NavSection> =>
  ({
    properties: {
      id,
      name,
      ...(insertBefore ? { insertBefore } : {}),
    },
    ...(requiredFlag ? { flags: { required: [requiredFlag] } } : {}),
    type: 'console.navigation/section',
  }) as EncodedExtension<NavSection>;

const namespacedNav = (
  id: string,
  name: string,
  model: CertManagerModel,
  section: string,
  requiredFlag?: string,
): EncodedExtension<ResourceNSNavItem> =>
  ({
    properties: {
      id,
      model: { group: model.group, version: model.version, kind: model.kind },
      name,
      section,
    },
    ...(requiredFlag ? { flags: { required: [requiredFlag] } } : {}),
    type: 'console.navigation/resource-ns',
  }) as EncodedExtension<ResourceNSNavItem>;

const clusterNav = (
  id: string,
  name: string,
  model: CertManagerModel,
  section: string,
  requiredFlag?: string,
): EncodedExtension<ResourceClusterNavItem> =>
  ({
    properties: {
      id,
      model: { group: model.group, version: model.version, kind: model.kind },
      name,
      section,
    },
    ...(requiredFlag ? { flags: { required: [requiredFlag] } } : {}),
    type: 'console.navigation/resource-cluster',
  }) as EncodedExtension<ResourceClusterNavItem>;

const separator = (id: string, section: string, requiredFlag?: string): EncodedExtension<Separator> =>
  ({
    properties: { id, section },
    ...(requiredFlag ? { flags: { required: [requiredFlag] } } : {}),
    type: 'console.navigation/separator',
  }) as EncodedExtension<Separator>;

const listPage = (
  model: CertManagerModel,
  codeRef: string,
  requiredFlag?: string,
): EncodedExtension<ResourceListPage> =>
  ({
    properties: {
      component: { $codeRef: codeRef },
      model: { group: model.group, version: model.version, kind: model.kind },
    },
    ...(requiredFlag ? { flags: { required: [requiredFlag] } } : {}),
    type: 'console.page/resource/list',
  }) as EncodedExtension<ResourceListPage>;

// Adds a "Certificate" tab to the details page of a resource kind this
// plugin does not own (Ingress, Service, and the Gateway API/external-dns
// kinds it doesn't have a nav entry for either) so the live-served-TLS-cert
// enrichment shows up alongside that resource's own tabs. This is the same
// mechanism the upstream console plugin template documents for augmenting
// pages owned by other plugins/console-core - there is no
// "list/detail page I don't own" extension point other than
// `console.tab/horizontalNav`.
const certificateTab = (
  id: string,
  group: string,
  version: string,
  kind: string,
  codeRef: string,
  requiredFlag?: string,
): EncodedExtension<HorizontalNavTab> =>
  ({
    properties: {
      component: { $codeRef: codeRef },
      model: { group, version, kind },
      page: { name: 'Certificate', href: 'certificate' },
    },
    ...(requiredFlag ? { flags: { required: [requiredFlag] } } : {}),
    type: 'console.tab/horizontalNav',
  }) as EncodedExtension<HorizontalNavTab>;

const dnsEndpointFlag = (): EncodedExtension<ModelFeatureFlag> =>
  ({
    properties: {
      flag: DNS_ENDPOINT_FLAG,
      model: { group: 'externaldns.k8s.io', version: 'v1alpha1', kind: 'DNSEndpoint' },
    },
    type: 'console.flag/model',
  }) as EncodedExtension<ModelFeatureFlag>;

const certManagerFlag = (): EncodedExtension<ModelFeatureFlag> =>
  ({
    properties: {
      flag: CERT_MANAGER_FLAG,
      model: { group: CertificateModel.group, version: CertificateModel.version, kind: CertificateModel.kind },
    },
    type: 'console.flag/model',
  }) as EncodedExtension<ModelFeatureFlag>;

export const extensions: EncodedExtension[] = [
  // --- "Cert Manager" nav group -------------------------------------------
  // Gated on CERT_MANAGER_FLAG (set once the Certificate CRD is resolvable)
  // so the whole group only shows up when cert-manager is actually installed.
  navSection(CERT_MANAGER_SECTION_ID, '%plugin__cert-manager~Cert Manager%', 'storage', CERT_MANAGER_FLAG),
  namespacedNav(
    'cert-manager-certificate',
    '%plugin__cert-manager~Certificates%',
    CertificateModel,
    CERT_MANAGER_SECTION_ID,
    CERT_MANAGER_FLAG,
  ),
  namespacedNav(
    'cert-manager-certificaterequest',
    '%plugin__cert-manager~CertificateRequests%',
    CertificateRequestModel,
    CERT_MANAGER_SECTION_ID,
    CERT_MANAGER_FLAG,
  ),
  separator('cert-manager-separator-0', CERT_MANAGER_SECTION_ID, CERT_MANAGER_FLAG),
  namespacedNav(
    'cert-manager-issuer',
    '%plugin__cert-manager~Issuers%',
    IssuerModel,
    CERT_MANAGER_SECTION_ID,
    CERT_MANAGER_FLAG,
  ),
  clusterNav(
    'cert-manager-clusterissuer',
    '%plugin__cert-manager~ClusterIssuers%',
    ClusterIssuerModel,
    CERT_MANAGER_SECTION_ID,
    CERT_MANAGER_FLAG,
  ),
  separator('cert-manager-separator-1', CERT_MANAGER_SECTION_ID, CERT_MANAGER_FLAG),
  namespacedNav(
    'cert-manager-order',
    '%plugin__cert-manager~Orders%',
    OrderModel,
    CERT_MANAGER_SECTION_ID,
    CERT_MANAGER_FLAG,
  ),
  namespacedNav(
    'cert-manager-challenge',
    '%plugin__cert-manager~Challenges%',
    ChallengeModel,
    CERT_MANAGER_SECTION_ID,
    CERT_MANAGER_FLAG,
  ),

  // --- "Trust Manager" nav group ------------------------------------------
  navSection(TRUST_MANAGER_SECTION_ID, '%plugin__cert-manager~Trust Manager%'),
  clusterNav('trust-manager-bundle', '%plugin__cert-manager~Bundles%', BundleModel, TRUST_MANAGER_SECTION_ID),

  // --- list pages -----------------------------------------------------------
  listPage(CertificateModel, 'lists.CertificateList', CERT_MANAGER_FLAG),
  listPage(CertificateRequestModel, 'lists.CertificateRequestList', CERT_MANAGER_FLAG),
  listPage(IssuerModel, 'lists.IssuerList', CERT_MANAGER_FLAG),
  listPage(ClusterIssuerModel, 'lists.ClusterIssuerList', CERT_MANAGER_FLAG),
  listPage(OrderModel, 'lists.OrderList', CERT_MANAGER_FLAG),
  listPage(ChallengeModel, 'lists.ChallengeList', CERT_MANAGER_FLAG),
  listPage(BundleModel, 'lists.BundleList'),

  // --- certificate enrichment: "Certificate" tab on resources this plugin ---
  // --- does not own ----------------------------------------------------------
  certificateTab('cert-manager-tab-ingress', 'networking.k8s.io', 'v1', 'Ingress', 'tabs.IngressCertificateTab'),
  certificateTab('cert-manager-tab-service', '', 'v1', 'Service', 'tabs.ServiceCertificateTab'),
  certificateTab(
    'cert-manager-tab-httproute',
    'gateway.networking.k8s.io',
    'v1',
    'HTTPRoute',
    'tabs.HTTPRouteCertificateTab',
  ),
  certificateTab(
    'cert-manager-tab-tlsroute',
    'gateway.networking.k8s.io',
    'v1alpha2',
    'TLSRoute',
    'tabs.TLSRouteCertificateTab',
  ),
  certificateTab(
    'cert-manager-tab-grpcroute',
    'gateway.networking.k8s.io',
    'v1',
    'GRPCRoute',
    'tabs.GRPCRouteCertificateTab',
  ),
  certificateTab(
    'cert-manager-tab-dnsendpoint',
    'externaldns.k8s.io',
    'v1alpha1',
    'DNSEndpoint',
    'tabs.DNSEndpointCertificateTab',
    DNS_ENDPOINT_FLAG,
  ),

  dnsEndpointFlag(),
  certManagerFlag(),
];
