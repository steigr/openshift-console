import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { PageComponentProps } from '@openshift-console/dynamic-plugin-sdk';

import { HelmReleaseModel, KustomizationModel } from '../../models';
import { GitRepositoryKind, HelmChartKind, HelmReleaseKind, KustomizationKind } from '../../types';
import { matchesReference, helmReleaseReferencesSource, helmReleaseReferencesHelmChart } from '../../utils/consumers';
import { ResourceRefRow, ResourceRefTable, useClusterWideWatch } from './ResourceRefTable';

// "Consumers" horizontalNav tab body for GitRepository: lists every
// Kustomization whose spec.sourceRef points at this GitRepository, and
// every HelmRelease whose chart template (spec.chart.spec.sourceRef) does.
// A HelmRelease's chartRef never points directly at a GitRepository (only
// at a HelmChart or OCIRepository), so chartRef isn't checked here - see
// utils/consumers.ts's helmReleaseReferencesSource.
export const GitRepositoryConsumersTab: React.FC<PageComponentProps<GitRepositoryKind>> = ({ obj }) => {
  const { t } = useTranslation('plugin__flux-console-plugin');
  const namespace = obj.metadata?.namespace || '';
  const name = obj.metadata?.name || '';

  const kustomizations = useClusterWideWatch<KustomizationKind>(KustomizationModel);
  const helmReleases = useClusterWideWatch<HelmReleaseKind>(HelmReleaseModel);

  const rows = React.useMemo<ResourceRefRow[]>(() => {
    const matchedKustomizations = kustomizations.data
      .filter((ks) => matchesReference(ks.spec?.sourceRef, ks.metadata?.namespace || '', 'GitRepository', namespace, name))
      .map((obj2) => ({ model: KustomizationModel, obj: obj2 }));
    const matchedHelmReleases = helmReleases.data
      .filter((hr) => helmReleaseReferencesSource(hr, 'GitRepository', namespace, name))
      .map((obj2) => ({ model: HelmReleaseModel, obj: obj2 }));
    return [...matchedKustomizations, ...matchedHelmReleases];
  }, [kustomizations.data, helmReleases.data, namespace, name]);

  return (
    <ResourceRefTable
      title={t('Consumers')}
      rows={rows}
      loaded={kustomizations.loaded && helmReleases.loaded}
      emptyText={t('No Kustomizations or HelmReleases reference this GitRepository')}
    />
  );
};

// "Consumers" horizontalNav tab body for HelmChart: lists every HelmRelease
// whose chart is this HelmChart - either the object helm-controller
// materializes for a HelmRelease's HelmChartTemplate, or one several
// HelmReleases share explicitly via spec.chartRef.
export const HelmChartConsumersTab: React.FC<PageComponentProps<HelmChartKind>> = ({ obj }) => {
  const { t } = useTranslation('plugin__flux-console-plugin');
  const namespace = obj.metadata?.namespace || '';
  const name = obj.metadata?.name || '';

  const helmReleases = useClusterWideWatch<HelmReleaseKind>(HelmReleaseModel);

  const rows = React.useMemo<ResourceRefRow[]>(
    () =>
      helmReleases.data
        .filter((hr) => helmReleaseReferencesHelmChart(hr, namespace, name))
        .map((obj2) => ({ model: HelmReleaseModel, obj: obj2 })),
    [helmReleases.data, namespace, name],
  );

  return (
    <ResourceRefTable
      title={t('Consumers')}
      rows={rows}
      loaded={helmReleases.loaded}
      emptyText={t('No HelmReleases reference this HelmChart')}
    />
  );
};
