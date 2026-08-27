import * as React from 'react';

import {
  AlertModel,
  ArtifactGeneratorModel,
  BucketModel,
  ExternalArtifactModel,
  FluxInstanceModel,
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
} from '../../models';
import {
  AlertKind,
  ArtifactGeneratorKind,
  BucketKind,
  ExternalArtifactKind,
  FluxInstanceKind,
  FluxReportKind,
  GitRepositoryKind,
  HelmChartKind,
  HelmReleaseKind,
  HelmRepositoryKind,
  ImagePolicyKind,
  ImageRepositoryKind,
  ImageUpdateAutomationKind,
  KustomizationKind,
  OCIRepositoryKind,
  ProviderKind,
  ReceiverKind,
  ResourceSetInputProviderKind,
  ResourceSetKind,
} from '../../types';
import { gitRefLabel, sourceRefLabel, suspendedLabel } from '../../utils/status';
import { getReadyStatus } from '../../utils/readyStatus';
import GenericResourceList, { ExtraColumn } from '../list/GenericResourceList';
import HelmChartStatusLink from '../list/HelmChartStatusLink';
import ReadyStatusIcon from '../list/ReadyStatusIcon';
import SourceRefLink from '../list/SourceRefLink';

const readyColumn = <
  T extends { spec?: Record<string, unknown>; status?: { conditions?: { type: string; status: string }[] } },
>(): ExtraColumn<T> => ({
  id: 'ready',
  title: 'Ready',
  render: (obj) => <ReadyStatusIcon obj={obj} />,
  // Sorts on the underlying reason text (e.g. "UpgradeSucceeded",
  // "ArtifactFailed") even though the cell itself renders as an icon -
  // groups the same status together without needing a fixed enum order.
  sortValue: (obj) => getReadyStatus(obj)?.label,
});

// --- group 1: applications ---------------------------------------------------

const helmReleaseColumns: ExtraColumn<HelmReleaseKind>[] = [
  {
    id: 'chart',
    title: 'Chart',
    render: (obj) => (
      <HelmChartStatusLink
        helmChartRef={obj.status?.helmChart}
        fallback={obj.spec?.chartRef?.name || obj.spec?.chart?.spec?.chart || '-'}
      />
    ),
    sortValue: (obj) => obj.spec?.chartRef?.name || obj.spec?.chart?.spec?.chart,
  },
  {
    id: 'revision',
    title: 'Revision',
    render: (obj) => obj.status?.lastAttemptedRevision || obj.status?.history?.[0]?.chartVersion || '-',
    sortValue: (obj) => obj.status?.lastAttemptedRevision || obj.status?.history?.[0]?.chartVersion,
  },
  readyColumn<HelmReleaseKind>(),
  {
    id: 'suspend',
    title: 'Status',
    render: (obj) => suspendedLabel(obj.spec?.suspend),
    sortValue: (obj) => suspendedLabel(obj.spec?.suspend),
  },
];

const helmChartColumns: ExtraColumn<HelmChartKind>[] = [
  { id: 'chart', title: 'Chart', render: (obj) => obj.spec?.chart || '-', sortValue: (obj) => obj.spec?.chart },
  { id: 'version', title: 'Version', render: (obj) => obj.spec?.version || '-', sortValue: (obj) => obj.spec?.version },
  {
    id: 'sourceRef',
    title: 'Source',
    render: (obj) => <SourceRefLink sourceRef={obj.spec?.sourceRef} namespace={obj.metadata?.namespace} />,
    sortValue: (obj) => sourceRefLabel(obj.spec?.sourceRef),
  },
  {
    id: 'revision',
    title: 'Revision',
    render: (obj) => obj.status?.artifact?.revision || '-',
    sortValue: (obj) => obj.status?.artifact?.revision,
  },
  readyColumn<HelmChartKind>(),
];

const kustomizationColumns: ExtraColumn<KustomizationKind>[] = [
  readyColumn<KustomizationKind>(),
  { id: 'path', title: 'Path', render: (obj) => obj.spec?.path || '-', sortValue: (obj) => obj.spec?.path },
  {
    id: 'sourceRef',
    title: 'Source',
    render: (obj) => <SourceRefLink sourceRef={obj.spec?.sourceRef} namespace={obj.metadata?.namespace} />,
    sortValue: (obj) => sourceRefLabel(obj.spec?.sourceRef),
  },
  {
    id: 'suspend',
    title: 'Status',
    render: (obj) => suspendedLabel(obj.spec?.suspend),
    sortValue: (obj) => suspendedLabel(obj.spec?.suspend),
  },
];

// --- group 2: sources ----------------------------------------------------------

const gitRepositoryColumns: ExtraColumn<GitRepositoryKind>[] = [
  { id: 'url', title: 'URL', render: (obj) => obj.spec?.url || '-', sortValue: (obj) => obj.spec?.url },
  { id: 'ref', title: 'Ref', render: (obj) => gitRefLabel(obj.spec?.ref), sortValue: (obj) => gitRefLabel(obj.spec?.ref) },
  readyColumn<GitRepositoryKind>(),
];

const ociRepositoryColumns: ExtraColumn<OCIRepositoryKind>[] = [
  { id: 'url', title: 'URL', render: (obj) => obj.spec?.url || '-', sortValue: (obj) => obj.spec?.url },
  {
    id: 'ref',
    title: 'Ref',
    render: (obj) => obj.spec?.ref?.tag || obj.spec?.ref?.semver || obj.spec?.ref?.digest || '-',
    sortValue: (obj) => obj.spec?.ref?.tag || obj.spec?.ref?.semver || obj.spec?.ref?.digest,
  },
  readyColumn<OCIRepositoryKind>(),
];

const helmRepositoryColumns: ExtraColumn<HelmRepositoryKind>[] = [
  readyColumn<HelmRepositoryKind>(),
  { id: 'url', title: 'URL', render: (obj) => obj.spec?.url || '-', sortValue: (obj) => obj.spec?.url },
  { id: 'type', title: 'Type', render: (obj) => obj.spec?.type || 'default', sortValue: (obj) => obj.spec?.type || 'default' },
];

const bucketColumns: ExtraColumn<BucketKind>[] = [
  readyColumn<BucketKind>(),
  { id: 'endpoint', title: 'Endpoint', render: (obj) => obj.spec?.endpoint || '-', sortValue: (obj) => obj.spec?.endpoint },
  { id: 'bucket', title: 'Bucket', render: (obj) => obj.spec?.bucketName || '-', sortValue: (obj) => obj.spec?.bucketName },
  { id: 'provider', title: 'Provider', render: (obj) => obj.spec?.provider || '-', sortValue: (obj) => obj.spec?.provider },
];

// --- group 3: artifacts (minimal) ------------------------------------------------

const artifactGeneratorColumns: ExtraColumn<ArtifactGeneratorKind>[] = [readyColumn<ArtifactGeneratorKind>()];
const externalArtifactColumns: ExtraColumn<ExternalArtifactKind>[] = [
  readyColumn<ExternalArtifactKind>(),
  {
    id: 'revision',
    title: 'Revision',
    render: (obj) => obj.status?.artifact?.revision || '-',
    sortValue: (obj) => obj.status?.artifact?.revision,
  },
];

// --- group 4: image automation (minimal) ------------------------------------------

const imageRepositoryColumns: ExtraColumn<ImageRepositoryKind>[] = [
  readyColumn<ImageRepositoryKind>(),
  { id: 'image', title: 'Image', render: (obj) => obj.spec?.image || '-', sortValue: (obj) => obj.spec?.image },
];
const imagePolicyColumns: ExtraColumn<ImagePolicyKind>[] = [
  readyColumn<ImagePolicyKind>(),
  {
    id: 'latest',
    title: 'Latest',
    render: (obj) => obj.status?.latestRef?.tag || obj.status?.latestRef?.digest || '-',
    sortValue: (obj) => obj.status?.latestRef?.tag || obj.status?.latestRef?.digest,
  },
];
const imageUpdateAutomationColumns: ExtraColumn<ImageUpdateAutomationKind>[] = [
  readyColumn<ImageUpdateAutomationKind>(),
  {
    id: 'lastRun',
    title: 'Last Run',
    render: (obj) => obj.status?.lastAutomationRunTime || '-',
    sortValue: (obj) => (obj.status?.lastAutomationRunTime ? Date.parse(obj.status.lastAutomationRunTime) : undefined),
  },
];

// --- group 5: notification -------------------------------------------------------

const providerColumns: ExtraColumn<ProviderKind>[] = [
  readyColumn<ProviderKind>(),
  { id: 'type', title: 'Type', render: (obj) => obj.spec?.type || '-', sortValue: (obj) => obj.spec?.type },
  {
    id: 'suspend',
    title: 'Status',
    render: (obj) => suspendedLabel(obj.spec?.suspend),
    sortValue: (obj) => suspendedLabel(obj.spec?.suspend),
  },
];

const receiverColumns: ExtraColumn<ReceiverKind>[] = [
  readyColumn<ReceiverKind>(),
  { id: 'type', title: 'Type', render: (obj) => obj.spec?.type || '-', sortValue: (obj) => obj.spec?.type },
  {
    id: 'webhookPath',
    title: 'Webhook Path',
    render: (obj) => obj.status?.webhookPath || '-',
    sortValue: (obj) => obj.status?.webhookPath,
  },
  {
    id: 'suspend',
    title: 'Status',
    render: (obj) => suspendedLabel(obj.spec?.suspend),
    sortValue: (obj) => suspendedLabel(obj.spec?.suspend),
  },
];

const alertColumns: ExtraColumn<AlertKind>[] = [
  readyColumn<AlertKind>(),
  {
    id: 'provider',
    title: 'Provider',
    render: (obj) => obj.spec?.providerRef?.name || '-',
    sortValue: (obj) => obj.spec?.providerRef?.name,
  },
  {
    id: 'severity',
    title: 'Severity',
    render: (obj) => obj.spec?.eventSeverity || '-',
    sortValue: (obj) => obj.spec?.eventSeverity,
  },
  {
    id: 'suspend',
    title: 'Status',
    render: (obj) => suspendedLabel(obj.spec?.suspend),
    sortValue: (obj) => suspendedLabel(obj.spec?.suspend),
  },
];

const fluxReportColumns: ExtraColumn<FluxReportKind>[] = [
  readyColumn<FluxReportKind>(),
  {
    id: 'distribution',
    title: 'Distribution',
    render: (obj) =>
      obj.spec?.distribution?.version
        ? `${obj.spec.distribution.version} (${obj.spec.distribution.status || '-'})`
        : '-',
    sortValue: (obj) => obj.spec?.distribution?.version,
  },
  {
    id: 'components',
    title: 'Components Ready',
    render: (obj) => {
      const components = obj.spec?.components;
      if (!components?.length) {
        return '-';
      }
      const ready = components.filter((c) => c.ready).length;
      return `${ready}/${components.length}`;
    },
    sortValue: (obj) => {
      const components = obj.spec?.components;
      if (!components?.length) {
        return undefined;
      }
      return components.filter((c) => c.ready).length / components.length;
    },
  },
];

// --- group 6: operator (minimal) --------------------------------------------------

const fluxInstanceColumns: ExtraColumn<FluxInstanceKind>[] = [
  readyColumn<FluxInstanceKind>(),
  {
    id: 'version',
    title: 'Version',
    render: (obj) => obj.spec?.distribution?.version || '-',
    sortValue: (obj) => obj.spec?.distribution?.version,
  },
];
const resourceSetColumns: ExtraColumn<ResourceSetKind>[] = [readyColumn<ResourceSetKind>()];
const resourceSetInputProviderColumns: ExtraColumn<ResourceSetInputProviderKind>[] = [
  readyColumn<ResourceSetInputProviderKind>(),
  { id: 'type', title: 'Type', render: (obj) => obj.spec?.type || '-', sortValue: (obj) => obj.spec?.type },
];

type ListProps = { namespace?: string };

// --- group 1 ---
export const HelmReleaseList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<HelmReleaseKind> model={HelmReleaseModel} namespace={namespace} useExtraColumns={() => helmReleaseColumns} />
);
export const HelmChartList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<HelmChartKind> model={HelmChartModel} namespace={namespace} useExtraColumns={() => helmChartColumns} />
);
export const KustomizationList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<KustomizationKind> model={KustomizationModel} namespace={namespace} useExtraColumns={() => kustomizationColumns} />
);

// --- group 2 ---
export const GitRepositoryList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<GitRepositoryKind> model={GitRepositoryModel} namespace={namespace} useExtraColumns={() => gitRepositoryColumns} />
);
export const OCIRepositoryList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<OCIRepositoryKind> model={OCIRepositoryModel} namespace={namespace} useExtraColumns={() => ociRepositoryColumns} />
);
export const HelmRepositoryList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<HelmRepositoryKind> model={HelmRepositoryModel} namespace={namespace} useExtraColumns={() => helmRepositoryColumns} />
);
export const BucketList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<BucketKind> model={BucketModel} namespace={namespace} useExtraColumns={() => bucketColumns} />
);

// --- group 3 ---
export const ArtifactGeneratorList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<ArtifactGeneratorKind>
    model={ArtifactGeneratorModel}
    namespace={namespace}
    useExtraColumns={() => artifactGeneratorColumns}
  />
);
export const ExternalArtifactList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<ExternalArtifactKind>
    model={ExternalArtifactModel}
    namespace={namespace}
    useExtraColumns={() => externalArtifactColumns}
  />
);

// --- group 4 ---
export const ImageRepositoryList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<ImageRepositoryKind>
    model={ImageRepositoryModel}
    namespace={namespace}
    useExtraColumns={() => imageRepositoryColumns}
  />
);
export const ImagePolicyList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<ImagePolicyKind> model={ImagePolicyModel} namespace={namespace} useExtraColumns={() => imagePolicyColumns} />
);
export const ImageUpdateAutomationList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<ImageUpdateAutomationKind>
    model={ImageUpdateAutomationModel}
    namespace={namespace}
    useExtraColumns={() => imageUpdateAutomationColumns}
  />
);

// --- group 5 ---
export const ProviderList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<ProviderKind> model={ProviderModel} namespace={namespace} useExtraColumns={() => providerColumns} />
);
export const ReceiverList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<ReceiverKind> model={ReceiverModel} namespace={namespace} useExtraColumns={() => receiverColumns} />
);
export const AlertList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<AlertKind> model={AlertModel} namespace={namespace} useExtraColumns={() => alertColumns} />
);
export const FluxReportList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<FluxReportKind> model={FluxReportModel} namespace={namespace} useExtraColumns={() => fluxReportColumns} />
);

// --- group 6 ---
export const FluxInstanceList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<FluxInstanceKind> model={FluxInstanceModel} namespace={namespace} useExtraColumns={() => fluxInstanceColumns} />
);
export const ResourceSetList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<ResourceSetKind> model={ResourceSetModel} namespace={namespace} useExtraColumns={() => resourceSetColumns} />
);
export const ResourceSetInputProviderList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<ResourceSetInputProviderKind>
    model={ResourceSetInputProviderModel}
    namespace={namespace}
    useExtraColumns={() => resourceSetInputProviderColumns}
  />
);
