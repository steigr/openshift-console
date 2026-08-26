// ReconcileCapability is present only on models the backend's
// /api/v1/reconcile endpoint (api/reconcile.go's reconcilableKinds) can
// actually trigger - the same fixed set `flux reconcile ...` itself
// supports. Its absence means the kind has no reconciler to trigger (e.g.
// Alert, Provider, FluxReport) or isn't wired up here (ArtifactGenerator,
// ExternalArtifact, FluxInstance, ResourceSet, ResourceSetInputProvider).
export type ReconcileCapability = {
  // Also reconcile the object's own source first, mirroring `flux reconcile
  // ... --with-source`. Only Kustomization, HelmRelease and HelmChart have
  // a source to reconcile this way.
  withSource?: boolean;
  // `flux reconcile helmrelease --force`/`--reset`. HelmRelease only.
  forceReset?: boolean;
};

export type FluxModel = {
  group: string;
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
  label: string;
  labelPlural: string;
  abbr: string;
  id: string;
  reconcile?: ReconcileCapability;
};

const HELM_TOOLKIT_GROUP = 'helm.toolkit.fluxcd.io';
const SOURCE_TOOLKIT_GROUP = 'source.toolkit.fluxcd.io';
const SOURCE_EXTENSIONS_GROUP = 'source.extensions.fluxcd.io';
const KUSTOMIZE_TOOLKIT_GROUP = 'kustomize.toolkit.fluxcd.io';
const IMAGE_TOOLKIT_GROUP = 'image.toolkit.fluxcd.io';
const NOTIFICATION_TOOLKIT_GROUP = 'notification.toolkit.fluxcd.io';
const CONTROLPLANE_GROUP = 'fluxcd.controlplane.io';

// --- group 1: applications ---------------------------------------------------

export const HelmReleaseModel: FluxModel = {
  group: HELM_TOOLKIT_GROUP,
  version: 'v2',
  kind: 'HelmRelease',
  plural: 'helmreleases',
  namespaced: true,
  label: 'HelmRelease',
  labelPlural: 'HelmReleases',
  abbr: 'HR',
  id: 'helmrelease',
  reconcile: { withSource: true, forceReset: true },
};

export const HelmChartModel: FluxModel = {
  group: SOURCE_TOOLKIT_GROUP,
  version: 'v1',
  kind: 'HelmChart',
  plural: 'helmcharts',
  namespaced: true,
  label: 'HelmChart',
  labelPlural: 'HelmCharts',
  abbr: 'HC',
  id: 'helmchart',
  reconcile: { withSource: true },
};

export const KustomizationModel: FluxModel = {
  group: KUSTOMIZE_TOOLKIT_GROUP,
  version: 'v1',
  kind: 'Kustomization',
  plural: 'kustomizations',
  namespaced: true,
  label: 'Kustomization',
  labelPlural: 'Kustomizations',
  abbr: 'K',
  id: 'kustomization',
  reconcile: { withSource: true },
};

// --- group 2: sources ---------------------------------------------------------

export const GitRepositoryModel: FluxModel = {
  group: SOURCE_TOOLKIT_GROUP,
  version: 'v1',
  kind: 'GitRepository',
  plural: 'gitrepositories',
  namespaced: true,
  label: 'GitRepository',
  labelPlural: 'GitRepositories',
  abbr: 'GR',
  id: 'gitrepository',
  reconcile: {},
};

export const OCIRepositoryModel: FluxModel = {
  group: SOURCE_TOOLKIT_GROUP,
  version: 'v1',
  kind: 'OCIRepository',
  plural: 'ocirepositories',
  namespaced: true,
  label: 'OCIRepository',
  labelPlural: 'OCIRepositories',
  abbr: 'OCI',
  id: 'ocirepository',
  reconcile: {},
};

export const HelmRepositoryModel: FluxModel = {
  group: SOURCE_TOOLKIT_GROUP,
  version: 'v1',
  kind: 'HelmRepository',
  plural: 'helmrepositories',
  namespaced: true,
  label: 'HelmRepository',
  labelPlural: 'HelmRepositories',
  abbr: 'HR',
  id: 'helmrepository',
  reconcile: {},
};

export const BucketModel: FluxModel = {
  group: SOURCE_TOOLKIT_GROUP,
  version: 'v1',
  kind: 'Bucket',
  plural: 'buckets',
  namespaced: true,
  label: 'Bucket',
  labelPlural: 'Buckets',
  abbr: 'B',
  id: 'bucket',
  reconcile: {},
};

// --- group 3: artifacts --------------------------------------------------------

export const ArtifactGeneratorModel: FluxModel = {
  group: SOURCE_EXTENSIONS_GROUP,
  version: 'v1beta1',
  kind: 'ArtifactGenerator',
  plural: 'artifactgenerators',
  namespaced: true,
  label: 'ArtifactGenerator',
  labelPlural: 'ArtifactGenerators',
  abbr: 'AG',
  id: 'artifactgenerator',
};

export const ExternalArtifactModel: FluxModel = {
  group: SOURCE_TOOLKIT_GROUP,
  version: 'v1',
  kind: 'ExternalArtifact',
  plural: 'externalartifacts',
  namespaced: true,
  label: 'ExternalArtifact',
  labelPlural: 'ExternalArtifacts',
  abbr: 'EA',
  id: 'externalartifact',
};

// --- group 4: image automation --------------------------------------------------

export const ImageRepositoryModel: FluxModel = {
  group: IMAGE_TOOLKIT_GROUP,
  version: 'v1',
  kind: 'ImageRepository',
  plural: 'imagerepositories',
  namespaced: true,
  label: 'ImageRepository',
  labelPlural: 'ImageRepositories',
  abbr: 'IR',
  id: 'imagerepository',
  reconcile: {},
};

export const ImagePolicyModel: FluxModel = {
  group: IMAGE_TOOLKIT_GROUP,
  version: 'v1',
  kind: 'ImagePolicy',
  plural: 'imagepolicies',
  namespaced: true,
  label: 'ImagePolicy',
  labelPlural: 'ImagePolicies',
  abbr: 'IP',
  id: 'imagepolicy',
  reconcile: {},
};

export const ImageUpdateAutomationModel: FluxModel = {
  group: IMAGE_TOOLKIT_GROUP,
  version: 'v1',
  kind: 'ImageUpdateAutomation',
  plural: 'imageupdateautomations',
  namespaced: true,
  label: 'ImageUpdateAutomation',
  labelPlural: 'ImageUpdateAutomations',
  abbr: 'IUA',
  id: 'imageupdateautomation',
  reconcile: {},
};

// --- group 5: notification -------------------------------------------------------

export const ProviderModel: FluxModel = {
  group: NOTIFICATION_TOOLKIT_GROUP,
  version: 'v1beta3',
  kind: 'Provider',
  plural: 'providers',
  namespaced: true,
  label: 'Provider',
  labelPlural: 'Providers',
  abbr: 'P',
  id: 'notification-provider',
};

export const ReceiverModel: FluxModel = {
  group: NOTIFICATION_TOOLKIT_GROUP,
  version: 'v1',
  kind: 'Receiver',
  plural: 'receivers',
  namespaced: true,
  label: 'Receiver',
  labelPlural: 'Receivers',
  abbr: 'R',
  id: 'receiver',
  reconcile: {},
};

export const AlertModel: FluxModel = {
  group: NOTIFICATION_TOOLKIT_GROUP,
  version: 'v1beta3',
  kind: 'Alert',
  plural: 'alerts',
  namespaced: true,
  label: 'Alert',
  labelPlural: 'Alerts',
  abbr: 'A',
  id: 'alert',
};

export const FluxReportModel: FluxModel = {
  group: CONTROLPLANE_GROUP,
  version: 'v1',
  kind: 'FluxReport',
  plural: 'fluxreports',
  namespaced: true,
  label: 'FluxReport',
  labelPlural: 'FluxReports',
  abbr: 'FR',
  id: 'fluxreport',
};

// --- group 6: operator ------------------------------------------------------------

export const FluxInstanceModel: FluxModel = {
  group: CONTROLPLANE_GROUP,
  version: 'v1',
  kind: 'FluxInstance',
  plural: 'fluxinstances',
  namespaced: true,
  label: 'FluxInstance',
  labelPlural: 'FluxInstances',
  abbr: 'FI',
  id: 'fluxinstance',
};

export const ResourceSetModel: FluxModel = {
  group: CONTROLPLANE_GROUP,
  version: 'v1',
  kind: 'ResourceSet',
  plural: 'resourcesets',
  namespaced: true,
  label: 'ResourceSet',
  labelPlural: 'ResourceSets',
  abbr: 'RS',
  id: 'resourceset',
};

export const ResourceSetInputProviderModel: FluxModel = {
  group: CONTROLPLANE_GROUP,
  version: 'v1',
  kind: 'ResourceSetInputProvider',
  plural: 'resourcesetinputproviders',
  namespaced: true,
  label: 'ResourceSetInputProvider',
  labelPlural: 'ResourceSetInputProviders',
  abbr: 'RSIP',
  id: 'resourcesetinputprovider',
};

export const referenceForModel = (model: FluxModel): string => `${model.group}~${model.version}~${model.kind}`;

// Adapts a FluxModel to the shape k8sPatchResource (and other
// dynamic-plugin-sdk k8s helpers) expect.
export const toK8sModel = (model: FluxModel) => ({
  abbr: model.abbr,
  kind: model.kind,
  label: model.label,
  labelPlural: model.labelPlural,
  plural: model.plural,
  apiVersion: model.version,
  apiGroup: model.group,
  namespaced: model.namespaced,
});
