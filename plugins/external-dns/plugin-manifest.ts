import { EncodedExtension } from '@openshift/dynamic-plugin-sdk-webpack';
import {
  HorizontalNavTab,
  ModelFeatureFlag,
  ResourceListPage,
  ResourceNSNavItem,
} from '@openshift-console/dynamic-plugin-sdk';
import { ConsolePluginBuildMetadata } from '@openshift-console/dynamic-plugin-sdk-webpack/lib/build-types';

import { DNSEndpointModel } from './src/models';

export const pluginMetadata: ConsolePluginBuildMetadata = {
  dependencies: {
    '@console/pluginAPI': '*',
  },
  description:
    'Surfaces external-dns DNSEndpoint resources in the Networking nav, exposes an EXTERNAL_DNS feature flag ' +
    'for other plugins to build on, and adds a "DNS Settings" tab (live registry ownership, A/AAAA/CNAME ' +
    'records and their TTLs) to Node, Ingress, Service, HTTPRoute, TLSRoute, GRPCRoute, TCPRoute, UDPRoute and ' +
    'DNSEndpoint pages.',
  displayName: 'External DNS console plugin',
  exposedModules: {
    lists: './components/lists/index.tsx',
    tabs: './components/tabs/DNSSettingsTab.tsx',
  },
  name: 'external-dns-console-plugin',
  version: '0.0.1',
};

// The built-in "Networking" nav section id, shared with core Console pages
// (Services, Routes, Ingresses, NetworkPolicies, ...).
const NETWORKING_SECTION_ID = 'networking';

const namespacedNav = (): EncodedExtension<ResourceNSNavItem> =>
  ({
    properties: {
      id: 'external-dns-dnsendpoint',
      model: {
        group: DNSEndpointModel.group,
        version: DNSEndpointModel.version,
        kind: DNSEndpointModel.kind,
      },
      name: '%plugin__external-dns-console-plugin~DNSEndpoints%',
      section: NETWORKING_SECTION_ID,
    },
    type: 'console.navigation/resource-ns',
  }) as EncodedExtension<ResourceNSNavItem>;

const listPage = (): EncodedExtension<ResourceListPage> =>
  ({
    properties: {
      component: { $codeRef: 'lists.DNSEndpointList' },
      model: {
        group: DNSEndpointModel.group,
        version: DNSEndpointModel.version,
        kind: DNSEndpointModel.kind,
      },
    },
    type: 'console.page/resource/list',
  }) as EncodedExtension<ResourceListPage>;

// Declarative flag driven purely by the DNSEndpoint CRD's presence on the
// cluster - readable via useFlag('EXTERNAL_DNS') by this plugin, Console core
// (see patches/0015-external-dns-column.patch), and any other dynamic plugin
// that wants to know external-dns is installed (e.g. a future cert-manager
// plugin deciding whether to show TLS/certificate info for a hostname).
const externalDnsFlag = (): EncodedExtension<ModelFeatureFlag> =>
  ({
    properties: {
      flag: 'EXTERNAL_DNS',
      model: {
        group: DNSEndpointModel.group,
        version: DNSEndpointModel.version,
        kind: DNSEndpointModel.kind,
      },
    },
    type: 'console.flag/model',
  }) as EncodedExtension<ModelFeatureFlag>;

// Adds a "DNS Settings" tab to the details page of a resource kind this
// plugin does not own (Ingress, Service, the Gateway API kinds) so the live
// registry-ownership/record enrichment shows up alongside that resource's
// own tabs - same mechanism, and the same set of kinds, as cert-manager's
// "Certificate" tab (plugins/cert-manager/plugin-manifest.ts).
const dnsSettingsTab = (
  id: string,
  group: string,
  version: string,
  kind: string,
  codeRef: string,
): EncodedExtension<HorizontalNavTab> =>
  ({
    properties: {
      component: { $codeRef: codeRef },
      model: { group, version, kind },
      page: { name: 'DNS Settings', href: 'dns-settings' },
    },
    type: 'console.tab/horizontalNav',
  }) as EncodedExtension<HorizontalNavTab>;

export const extensions: EncodedExtension[] = [
  namespacedNav(),
  listPage(),
  externalDnsFlag(),

  // --- DNS settings enrichment: "DNS Settings" tab -------------------------
  dnsSettingsTab('external-dns-tab-ingress', 'networking.k8s.io', 'v1', 'Ingress', 'tabs.IngressDNSSettingsTab'),
  dnsSettingsTab('external-dns-tab-service', '', 'v1', 'Service', 'tabs.ServiceDNSSettingsTab'),
  dnsSettingsTab(
    'external-dns-tab-httproute',
    'gateway.networking.k8s.io',
    'v1',
    'HTTPRoute',
    'tabs.HTTPRouteDNSSettingsTab',
  ),
  dnsSettingsTab(
    'external-dns-tab-tlsroute',
    'gateway.networking.k8s.io',
    'v1alpha2',
    'TLSRoute',
    'tabs.TLSRouteDNSSettingsTab',
  ),
  dnsSettingsTab(
    'external-dns-tab-grpcroute',
    'gateway.networking.k8s.io',
    'v1',
    'GRPCRoute',
    'tabs.GRPCRouteDNSSettingsTab',
  ),
  dnsSettingsTab(
    'external-dns-tab-tcproute',
    'gateway.networking.k8s.io',
    'v1alpha2',
    'TCPRoute',
    'tabs.TCPRouteDNSSettingsTab',
  ),
  dnsSettingsTab(
    'external-dns-tab-udproute',
    'gateway.networking.k8s.io',
    'v1alpha2',
    'UDPRoute',
    'tabs.UDPRouteDNSSettingsTab',
  ),
  dnsSettingsTab(
    'external-dns-tab-dnsendpoint',
    DNSEndpointModel.group,
    DNSEndpointModel.version,
    DNSEndpointModel.kind,
    'tabs.DNSEndpointDNSSettingsTab',
  ),
  dnsSettingsTab('external-dns-tab-node', '', 'v1', 'Node', 'tabs.NodeDNSSettingsTab'),
];
