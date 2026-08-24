export type ExternalSecretsModel = {
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

const GROUP = 'external-secrets.io';

export const ExternalSecretModel: ExternalSecretsModel = {
  group: GROUP,
  version: 'v1',
  kind: 'ExternalSecret',
  plural: 'externalsecrets',
  namespaced: true,
  label: 'ExternalSecret',
  labelPlural: 'ExternalSecrets',
  abbr: 'ES',
  id: 'externalsecret',
};

export const PushSecretModel: ExternalSecretsModel = {
  group: GROUP,
  version: 'v1alpha1',
  kind: 'PushSecret',
  plural: 'pushsecrets',
  namespaced: true,
  label: 'PushSecret',
  labelPlural: 'PushSecrets',
  abbr: 'PS',
  id: 'pushsecret',
};

export const ClusterExternalSecretModel: ExternalSecretsModel = {
  group: GROUP,
  version: 'v1',
  kind: 'ClusterExternalSecret',
  plural: 'clusterexternalsecrets',
  namespaced: false,
  label: 'ClusterExternalSecret',
  labelPlural: 'ClusterExternalSecrets',
  abbr: 'CES',
  id: 'clusterexternalsecret',
};

export const ClusterPushSecretModel: ExternalSecretsModel = {
  group: GROUP,
  version: 'v1alpha1',
  kind: 'ClusterPushSecret',
  plural: 'clusterpushsecrets',
  namespaced: false,
  label: 'ClusterPushSecret',
  labelPlural: 'ClusterPushSecrets',
  abbr: 'CPS',
  id: 'clusterpushsecret',
};

export const SecretStoreModel: ExternalSecretsModel = {
  group: GROUP,
  version: 'v1',
  kind: 'SecretStore',
  plural: 'secretstores',
  namespaced: true,
  label: 'SecretStore',
  labelPlural: 'SecretStores',
  abbr: 'SS',
  id: 'secretstore',
};

export const ClusterSecretStoreModel: ExternalSecretsModel = {
  group: GROUP,
  version: 'v1',
  kind: 'ClusterSecretStore',
  plural: 'clustersecretstores',
  namespaced: false,
  label: 'ClusterSecretStore',
  labelPlural: 'ClusterSecretStores',
  abbr: 'CSS',
  id: 'clustersecretstore',
};

export const referenceForModel = (model: ExternalSecretsModel): string =>
  `${model.group}~${model.version}~${model.kind}`;
