import { EncodedExtension } from '@openshift/dynamic-plugin-sdk-webpack';
import {
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
    'Surfaces external-dns DNSEndpoint resources in the Networking nav, and exposes an EXTERNAL_DNS feature flag for other plugins to build on.',
  displayName: 'External DNS console plugin',
  exposedModules: {
    lists: './components/lists/index.tsx',
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
      name: '%plugin__external-dns~DNSEndpoints%',
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

export const extensions: EncodedExtension[] = [
  namespacedNav(),
  listPage(),
  externalDnsFlag(),
];
