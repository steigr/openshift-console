import { EncodedExtension } from '@openshift/dynamic-plugin-sdk-webpack';
import {
  DetailsItem,
  HorizontalNavTab,
  ModelFeatureFlag,
  NavSection,
  ResourceListPage,
  ResourceNSNavItem,
  Separator,
} from '@openshift-console/dynamic-plugin-sdk';
import { ConsolePluginBuildMetadata } from '@openshift-console/dynamic-plugin-sdk-webpack/lib/build-types';

import {
  AlertModel,
  ArtifactGeneratorModel,
  BucketModel,
  ExternalArtifactModel,
  FluxInstanceModel,
  FluxModel,
  FluxReportModel,
  GitRepositoryModel,
  HelmChartModel,
  HelmReleaseModel,
  HelmRepositoryModel,
  ImagePolicyModel,
  ImageRepositoryModel,
  ImageUpdateAutomationModel,
  KustomizationModel,
  OCIRepositoryModel,
  ProviderModel,
  ReceiverModel,
  ResourceSetInputProviderModel,
  ResourceSetModel,
} from './src/models';

export const pluginMetadata: ConsolePluginBuildMetadata = {
  dependencies: {
    '@console/pluginAPI': '*',
  },
  description:
    'Adds a FluxCD navigation group and list views for the GitOps Toolkit ' +
    '(source/kustomize/helm/notification/image.toolkit.fluxcd.io), the source-extensions ' +
    'ArtifactGenerator/ExternalArtifact CRDs, and the flux-operator (fluxcd.controlplane.io) CRDs.',
  displayName: 'FluxCD console plugin',
  exposedModules: {
    lists: './components/lists/index.tsx',
    'details-items': './components/details/FluxDetailsItems.tsx',
    tabs: './components/tabs/ConsumersTab.tsx',
    'dependencies-tab': './components/tabs/DependenciesTab.tsx',
  },
  name: 'flux-console-plugin',
  version: '0.0.1',
};

const FLUX_SECTION_ID = 'flux';

// Gates the whole "FluxCD" nav group (section, nav items, list pages) so it
// only appears once the GitOps Toolkit is actually installed - set when
// Console can resolve the Kustomization model (kustomize-controller is the
// one component every flux2 distribution ships).
const FLUX_FLAG = 'FLUX';

const navSection = (
  id: string,
  name: string,
  insertAfter?: string,
  requiredFlag?: string,
): EncodedExtension<NavSection> =>
  ({
    properties: { id, name, ...(insertAfter ? { insertAfter } : {}) },
    ...(requiredFlag ? { flags: { required: [requiredFlag] } } : {}),
    type: 'console.navigation/section',
  }) as EncodedExtension<NavSection>;

const namespacedNav = (
  id: string,
  name: string,
  model: FluxModel,
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

const separator = (id: string, section: string, requiredFlag?: string): EncodedExtension<Separator> =>
  ({
    properties: { id, section },
    ...(requiredFlag ? { flags: { required: [requiredFlag] } } : {}),
    type: 'console.navigation/separator',
  }) as EncodedExtension<Separator>;

const listPage = (model: FluxModel, codeRef: string, requiredFlag?: string): EncodedExtension<ResourceListPage> =>
  ({
    properties: {
      component: { $codeRef: codeRef },
      model: { group: model.group, version: model.version, kind: model.kind },
    },
    ...(requiredFlag ? { flags: { required: [requiredFlag] } } : {}),
    type: 'console.page/resource/list',
  }) as EncodedExtension<ResourceListPage>;

// Adds a field to the *default* Details tab's right column for a resource
// this plugin owns - slots straight into console's existing resource
// summary rather than needing a whole owned page (see cert-manager's
// plugin-manifest.ts for the same pattern).
const detailsItem = (
  id: string,
  model: FluxModel,
  title: string,
  codeRef: string,
  sortWeight: number,
  requiredFlag?: string,
): EncodedExtension<DetailsItem> =>
  ({
    properties: {
      column: 'right',
      component: { $codeRef: codeRef },
      id,
      model: { group: model.group, version: model.version, kind: model.kind },
      sortWeight,
      title,
    },
    ...(requiredFlag ? { flags: { required: [requiredFlag] } } : {}),
    type: 'console.resource/details-item',
  }) as EncodedExtension<DetailsItem>;

// Adds a whole extra tab to a resource's own details page (unlike
// detailsItem, which only adds one field to the existing Details tab).
const horizontalNavTab = (
  id: string,
  model: FluxModel,
  name: string,
  href: string,
  codeRef: string,
  requiredFlag?: string,
): EncodedExtension<HorizontalNavTab> =>
  ({
    properties: {
      component: { $codeRef: codeRef },
      model: { group: model.group, version: model.version, kind: model.kind },
      page: { name, href },
    },
    ...(requiredFlag ? { flags: { required: [requiredFlag] } } : {}),
    type: 'console.tab/horizontalNav',
  }) as EncodedExtension<HorizontalNavTab>;

const fluxFlag = (): EncodedExtension<ModelFeatureFlag> =>
  ({
    properties: {
      flag: FLUX_FLAG,
      model: { group: KustomizationModel.group, version: KustomizationModel.version, kind: KustomizationModel.kind },
    },
    type: 'console.flag/model',
  }) as EncodedExtension<ModelFeatureFlag>;

export const extensions: EncodedExtension[] = [
  // --- "FluxCD" nav group, gated on FLUX_FLAG ------------------------------
  navSection(FLUX_SECTION_ID, '%plugin__flux~FluxCD%', 'workloads', FLUX_FLAG),

  // group 1: applications
  namespacedNav('flux-helmrelease', '%plugin__flux~HelmReleases%', HelmReleaseModel, FLUX_SECTION_ID, FLUX_FLAG),
  namespacedNav('flux-helmchart', '%plugin__flux~HelmCharts%', HelmChartModel, FLUX_SECTION_ID, FLUX_FLAG),
  namespacedNav('flux-kustomization', '%plugin__flux~Kustomizations%', KustomizationModel, FLUX_SECTION_ID, FLUX_FLAG),
  separator('flux-separator-0', FLUX_SECTION_ID, FLUX_FLAG),

  // group 2: sources
  namespacedNav('flux-gitrepository', '%plugin__flux~GitRepositories%', GitRepositoryModel, FLUX_SECTION_ID, FLUX_FLAG),
  namespacedNav('flux-ocirepository', '%plugin__flux~OCIRepositories%', OCIRepositoryModel, FLUX_SECTION_ID, FLUX_FLAG),
  namespacedNav('flux-helmrepository', '%plugin__flux~HelmRepositories%', HelmRepositoryModel, FLUX_SECTION_ID, FLUX_FLAG),
  namespacedNav('flux-bucket', '%plugin__flux~Buckets%', BucketModel, FLUX_SECTION_ID, FLUX_FLAG),
  separator('flux-separator-1', FLUX_SECTION_ID, FLUX_FLAG),

  // group 3: artifacts
  namespacedNav(
    'flux-artifactgenerator',
    '%plugin__flux~ArtifactGenerators%',
    ArtifactGeneratorModel,
    FLUX_SECTION_ID,
    FLUX_FLAG,
  ),
  namespacedNav(
    'flux-externalartifact',
    '%plugin__flux~ExternalArtifacts%',
    ExternalArtifactModel,
    FLUX_SECTION_ID,
    FLUX_FLAG,
  ),
  separator('flux-separator-2', FLUX_SECTION_ID, FLUX_FLAG),

  // group 4: image automation
  namespacedNav(
    'flux-imagerepository',
    '%plugin__flux~ImageRepositories%',
    ImageRepositoryModel,
    FLUX_SECTION_ID,
    FLUX_FLAG,
  ),
  namespacedNav('flux-imagepolicy', '%plugin__flux~ImagePolicies%', ImagePolicyModel, FLUX_SECTION_ID, FLUX_FLAG),
  namespacedNav(
    'flux-imageupdateautomation',
    '%plugin__flux~ImageUpdateAutomations%',
    ImageUpdateAutomationModel,
    FLUX_SECTION_ID,
    FLUX_FLAG,
  ),
  separator('flux-separator-3', FLUX_SECTION_ID, FLUX_FLAG),

  // group 5: notification
  namespacedNav('flux-provider', '%plugin__flux~Providers%', ProviderModel, FLUX_SECTION_ID, FLUX_FLAG),
  namespacedNav('flux-receiver', '%plugin__flux~Receivers%', ReceiverModel, FLUX_SECTION_ID, FLUX_FLAG),
  namespacedNav('flux-alert', '%plugin__flux~Alerts%', AlertModel, FLUX_SECTION_ID, FLUX_FLAG),
  namespacedNav('flux-fluxreport', '%plugin__flux~FluxReports%', FluxReportModel, FLUX_SECTION_ID, FLUX_FLAG),
  separator('flux-separator-4', FLUX_SECTION_ID, FLUX_FLAG),

  // group 6: operator
  namespacedNav('flux-fluxinstance', '%plugin__flux~FluxInstances%', FluxInstanceModel, FLUX_SECTION_ID, FLUX_FLAG),
  namespacedNav('flux-resourceset', '%plugin__flux~ResourceSets%', ResourceSetModel, FLUX_SECTION_ID, FLUX_FLAG),
  namespacedNav(
    'flux-resourcesetinputprovider',
    '%plugin__flux~ResourceSetInputProviders%',
    ResourceSetInputProviderModel,
    FLUX_SECTION_ID,
    FLUX_FLAG,
  ),

  // --- list pages -----------------------------------------------------------
  listPage(HelmReleaseModel, 'lists.HelmReleaseList', FLUX_FLAG),
  listPage(HelmChartModel, 'lists.HelmChartList', FLUX_FLAG),
  listPage(KustomizationModel, 'lists.KustomizationList', FLUX_FLAG),
  listPage(GitRepositoryModel, 'lists.GitRepositoryList', FLUX_FLAG),
  listPage(OCIRepositoryModel, 'lists.OCIRepositoryList', FLUX_FLAG),
  listPage(HelmRepositoryModel, 'lists.HelmRepositoryList', FLUX_FLAG),
  listPage(BucketModel, 'lists.BucketList', FLUX_FLAG),
  listPage(ArtifactGeneratorModel, 'lists.ArtifactGeneratorList', FLUX_FLAG),
  listPage(ExternalArtifactModel, 'lists.ExternalArtifactList', FLUX_FLAG),
  listPage(ImageRepositoryModel, 'lists.ImageRepositoryList', FLUX_FLAG),
  listPage(ImagePolicyModel, 'lists.ImagePolicyList', FLUX_FLAG),
  listPage(ImageUpdateAutomationModel, 'lists.ImageUpdateAutomationList', FLUX_FLAG),
  listPage(ProviderModel, 'lists.ProviderList', FLUX_FLAG),
  listPage(ReceiverModel, 'lists.ReceiverList', FLUX_FLAG),
  listPage(AlertModel, 'lists.AlertList', FLUX_FLAG),
  listPage(FluxReportModel, 'lists.FluxReportList', FLUX_FLAG),
  listPage(FluxInstanceModel, 'lists.FluxInstanceList', FLUX_FLAG),
  listPage(ResourceSetModel, 'lists.ResourceSetList', FLUX_FLAG),
  listPage(ResourceSetInputProviderModel, 'lists.ResourceSetInputProviderList', FLUX_FLAG),

  // --- details items: access-secret link on every source kind that has one ---
  detailsItem(
    'flux-detail-gitrepository-secret',
    GitRepositoryModel,
    'Access Secret',
    'details-items.SecretRefItem',
    200,
    FLUX_FLAG,
  ),
  detailsItem(
    'flux-detail-helmrepository-secret',
    HelmRepositoryModel,
    'Access Secret',
    'details-items.SecretRefItem',
    200,
    FLUX_FLAG,
  ),
  detailsItem(
    'flux-detail-ocirepository-secret',
    OCIRepositoryModel,
    'Access Secret',
    'details-items.SecretRefItem',
    200,
    FLUX_FLAG,
  ),
  detailsItem('flux-detail-bucket-secret', BucketModel, 'Access Secret', 'details-items.SecretRefItem', 200, FLUX_FLAG),

  // --- cross-linking: "Consumers" tab on GitRepository and HelmChart ---------
  horizontalNavTab(
    'flux-tab-gitrepository-consumers',
    GitRepositoryModel,
    'Consumers',
    'consumers',
    'tabs.GitRepositoryConsumersTab',
    FLUX_FLAG,
  ),
  horizontalNavTab(
    'flux-tab-helmchart-consumers',
    HelmChartModel,
    'Consumers',
    'consumers',
    'tabs.HelmChartConsumersTab',
    FLUX_FLAG,
  ),
  horizontalNavTab(
    'flux-tab-helmrelease-dependencies',
    HelmReleaseModel,
    'Dependencies',
    'dependencies',
    'dependencies-tab.HelmReleaseDependenciesTab',
    FLUX_FLAG,
  ),

  fluxFlag(),
];
