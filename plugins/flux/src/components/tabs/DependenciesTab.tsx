import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { PageComponentProps } from '@openshift-console/dynamic-plugin-sdk';

import { HelmReleaseModel } from '../../models';
import { HelmReleaseKind } from '../../types';
import { ResourceRefRow, ResourceRefTable, useClusterWideWatch } from './ResourceRefTable';

// "Dependencies" horizontalNav tab body for HelmRelease: lists both
// directions of `spec.dependsOn` (a HelmRelease can only depend on other
// HelmReleases, per the CRD schema - no `kind` field on a dependsOn entry).
//
// - Dependencies: the HelmReleases this one's own spec.dependsOn names -
//   helm-controller won't reconcile this HelmRelease until each is Ready.
// - Dependents: every other HelmRelease (cluster-wide, not just this one's
//   namespace - a dependent is frequently elsewhere) whose own
//   spec.dependsOn names this one.
//
// A single cluster-wide HelmRelease watch covers both directions: it's
// needed to resolve Dependents regardless, and doubles as the live Ready
// status for each Dependency (a dependsOn entry referencing a HelmRelease
// this watch hasn't turned up - broken reference, or just not visible under
// the caller's RBAC - still renders as a working ResourceLink, just with no
// Ready condition to show).
export const HelmReleaseDependenciesTab: React.FC<PageComponentProps<HelmReleaseKind>> = ({ obj }) => {
  const { t } = useTranslation('plugin__flux');
  const namespace = obj.metadata?.namespace || '';
  const name = obj.metadata?.name || '';

  const helmReleases = useClusterWideWatch<HelmReleaseKind>(HelmReleaseModel);

  const dependencyRows = React.useMemo<ResourceRefRow[]>(() => {
    const dependsOn = obj.spec?.dependsOn || [];
    return dependsOn
      .filter((ref) => ref.name)
      .map((ref) => {
        const depNamespace = ref.namespace || namespace;
        const found = helmReleases.data.find(
          (hr) => hr.metadata?.namespace === depNamespace && hr.metadata?.name === ref.name,
        );
        return { model: HelmReleaseModel, obj: found || { metadata: { namespace: depNamespace, name: ref.name } } };
      });
  }, [obj.spec?.dependsOn, helmReleases.data, namespace]);

  const dependentRows = React.useMemo<ResourceRefRow[]>(
    () =>
      helmReleases.data
        .filter((hr) =>
          (hr.spec?.dependsOn || []).some(
            (ref) => ref.name === name && (ref.namespace || hr.metadata?.namespace || '') === namespace,
          ),
        )
        .map((hr) => ({ model: HelmReleaseModel, obj: hr })),
    [helmReleases.data, namespace, name],
  );

  return (
    <>
      <ResourceRefTable
        title={t('Dependencies')}
        rows={dependencyRows}
        loaded={helmReleases.loaded}
        emptyText={t('This HelmRelease has no dependencies')}
      />
      <ResourceRefTable
        title={t('Dependents')}
        rows={dependentRows}
        loaded={helmReleases.loaded}
        emptyText={t('No HelmReleases depend on this one')}
      />
    </>
  );
};
