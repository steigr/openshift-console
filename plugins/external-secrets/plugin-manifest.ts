import { EncodedExtension } from '@openshift/dynamic-plugin-sdk-webpack';
import {
  NavSection,
  ResourceClusterNavItem,
  ResourceListPage,
  ResourceNSNavItem,
  Separator,
} from '@openshift-console/dynamic-plugin-sdk';
import { ConsolePluginBuildMetadata } from '@openshift-console/dynamic-plugin-sdk-webpack/lib/build-types';

import {
  ClusterExternalSecretModel,
  ClusterPushSecretModel,
  ClusterSecretStoreModel,
  ExternalSecretModel,
  ExternalSecretsModel,
  PushSecretModel,
  SecretStoreModel,
} from './src/models';

export const pluginMetadata: ConsolePluginBuildMetadata = {
  dependencies: {
    '@console/pluginAPI': '*',
  },
  description: 'Adds navigation, list views, and a Force refresh action for external-secrets.io resources.',
  displayName: 'External Secrets console plugin',
  exposedModules: {
    lists: './components/lists/index.tsx',
  },
  name: 'external-secrets-console-plugin',
  version: '0.0.1',
};

const SECTION_ID = 'external-secrets';

const navSection = (): EncodedExtension<NavSection> =>
  ({
    properties: {
      id: SECTION_ID,
      name: '%plugin__external-secrets~External Secrets%',
      insertBefore: 'storage',
    },
    type: 'console.navigation/section',
  }) as EncodedExtension<NavSection>;

const namespacedNav = (
  id: string,
  name: string,
  model: ExternalSecretsModel,
): EncodedExtension<ResourceNSNavItem> =>
  ({
    properties: {
      id,
      model: { group: model.group, version: model.version, kind: model.kind },
      name,
      section: SECTION_ID,
    },
    type: 'console.navigation/resource-ns',
  }) as EncodedExtension<ResourceNSNavItem>;

const clusterNav = (
  id: string,
  name: string,
  model: ExternalSecretsModel,
): EncodedExtension<ResourceClusterNavItem> =>
  ({
    properties: {
      id,
      model: { group: model.group, version: model.version, kind: model.kind },
      name,
      section: SECTION_ID,
    },
    type: 'console.navigation/resource-cluster',
  }) as EncodedExtension<ResourceClusterNavItem>;

const separator = (id: string): EncodedExtension<Separator> =>
  ({
    properties: { id, section: SECTION_ID },
    type: 'console.navigation/separator',
  }) as EncodedExtension<Separator>;

const listPage = (
  model: ExternalSecretsModel,
  codeRef: string,
): EncodedExtension<ResourceListPage> =>
  ({
    properties: {
      component: { $codeRef: codeRef },
      model: { group: model.group, version: model.version, kind: model.kind },
    },
    type: 'console.page/resource/list',
  }) as EncodedExtension<ResourceListPage>;

export const extensions: EncodedExtension[] = [
  navSection(),
  namespacedNav('external-secrets-externalsecret', '%plugin__external-secrets~ExternalSecrets%', ExternalSecretModel),
  namespacedNav('external-secrets-pushsecret', '%plugin__external-secrets~PushSecrets%', PushSecretModel),
  separator('external-secrets-separator-0'),
  clusterNav('external-secrets-clusterexternalsecret', '%plugin__external-secrets~ClusterExternalSecrets%', ClusterExternalSecretModel),
  clusterNav('external-secrets-clusterpushsecret', '%plugin__external-secrets~ClusterPushSecrets%', ClusterPushSecretModel),
  separator('external-secrets-separator-1'),
  namespacedNav('external-secrets-secretstore', '%plugin__external-secrets~SecretStores%', SecretStoreModel),
  clusterNav('external-secrets-clustersecretstore', '%plugin__external-secrets~ClusterSecretStores%', ClusterSecretStoreModel),

  listPage(ExternalSecretModel, 'lists.ExternalSecretList'),
  listPage(PushSecretModel, 'lists.PushSecretList'),
  listPage(ClusterExternalSecretModel, 'lists.ClusterExternalSecretList'),
  listPage(ClusterPushSecretModel, 'lists.ClusterPushSecretList'),
  listPage(SecretStoreModel, 'lists.SecretStoreList'),
  listPage(ClusterSecretStoreModel, 'lists.ClusterSecretStoreList'),
];
