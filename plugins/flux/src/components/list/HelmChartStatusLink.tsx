import * as React from 'react';
import { ResourceLink } from '@openshift-console/dynamic-plugin-sdk';

import { HelmChartModel } from '../../models';

// Renders a HelmRelease's status.helmChart ("namespace/name") as a link to
// the actual HelmChart object source-controller creates/owns on its
// behalf, the same way the Namespace column links to a Namespace - only
// set when the HelmRelease uses spec.chart (a HelmChartTemplate) rather
// than spec.chartRef (which points straight at a chart already living in
// an OCIRepository/HelmRepository, with no HelmChart CR involved), hence
// the fallback for that case.
const HelmChartStatusLink: React.FC<{ helmChartRef?: string; fallback?: React.ReactNode }> = ({
  helmChartRef,
  fallback = '-',
}) => {
  const [namespace, name] = helmChartRef?.split('/') || [];
  if (!name) {
    return <>{fallback}</>;
  }
  return (
    <ResourceLink
      groupVersionKind={{ group: HelmChartModel.group, version: HelmChartModel.version, kind: HelmChartModel.kind }}
      name={name}
      namespace={namespace}
    />
  );
};

export default HelmChartStatusLink;
