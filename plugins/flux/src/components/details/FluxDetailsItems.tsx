import * as React from 'react';
import { DetailsItemComponentProps, K8sResourceCommon, ResourceLink } from '@openshift-console/dynamic-plugin-sdk';

import { HelmChartModel } from '../../models';
import { HelmReleaseKind, LocalObjectReference } from '../../types';

type SourceWithSecretRef = K8sResourceCommon & { spec?: { secretRef?: LocalObjectReference } };

// console.resource/details-item component for every Flux source kind that
// carries an access-credentials secretRef (GitRepository, HelmRepository,
// OCIRepository, Bucket) - registered per-model in plugin-manifest.ts to add
// to the *default* Details tab's right column. secretRef is always a Secret
// in the object's own namespace (verified against a live cluster's CRD
// schema - no namespace field exists on it), never set for a source that
// needs no credentials (e.g. an anonymous public GitRepository), in which
// case this simply renders "-" rather than the whole item being omitted.
export const SecretRefItem: React.FC<DetailsItemComponentProps<SourceWithSecretRef>> = ({ obj }) => {
  const secretName = obj.spec?.secretRef?.name;
  if (!secretName) {
    return <>-</>;
  }
  return (
    <ResourceLink
      groupVersionKind={{ group: '', version: 'v1', kind: 'Secret' }}
      name={secretName}
      namespace={obj.metadata?.namespace}
    />
  );
};

// console.resource/details-item component for HelmRelease, linking to the
// HelmChart CR that source-controller creates/owns to fetch the chart on
// its behalf (status.helmChart, a "namespace/name" string) - only set when
// the HelmRelease uses spec.chart rather than spec.chartRef (which points
// straight at a chart already living in an OCIRepository/HelmRepository,
// with no HelmChart CR involved). Labelled with the chart name + the
// revision actually installed, e.g. "monitoring-prometheus-adapter@45.0.3".
export const HelmChartRefItem: React.FC<DetailsItemComponentProps<HelmReleaseKind>> = ({ obj }) => {
  const ref = obj.status?.helmChart;
  if (!ref) {
    return <>-</>;
  }
  const [namespace, name] = ref.split('/');
  if (!name) {
    return <>-</>;
  }
  const revision = obj.status?.lastAttemptedRevision || obj.status?.history?.[0]?.chartVersion;
  return (
    <ResourceLink
      groupVersionKind={{ group: HelmChartModel.group, version: HelmChartModel.version, kind: HelmChartModel.kind }}
      name={name}
      namespace={namespace}
      displayName={revision ? `${name}@${revision}` : name}
    />
  );
};
