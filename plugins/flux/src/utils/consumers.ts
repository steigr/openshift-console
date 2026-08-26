import { CrossNamespaceObjectReference, HelmReleaseKind } from '../types';

// True when ref points at (targetKind, targetNamespace/targetName) - a
// missing ref.namespace defaults to the referencing object's own namespace,
// same as every Flux controller's own sourceRef/chartRef resolution.
export const matchesReference = (
  ref: CrossNamespaceObjectReference | undefined,
  consumerNamespace: string,
  targetKind: string,
  targetNamespace: string,
  targetName: string,
): boolean => {
  if (!ref?.kind || !ref?.name) {
    return false;
  }
  return ref.kind === targetKind && ref.name === targetName && (ref.namespace || consumerNamespace) === targetNamespace;
};

// The HelmChart a HelmRelease implies when it has no explicit chartRef and
// instead uses a HelmChartTemplate (spec.chart.spec) - helm-controller
// materializes one named "<release-namespace>-<release-name>" in the
// template's own sourceRef namespace. Mirrors api/reconcile.go's
// resolveSource on the backend. Returns undefined for a HelmRelease that
// has an explicit chartRef instead (nothing implied), or no chart spec at
// all.
export const impliedHelmChartRef = (hr: HelmReleaseKind): { namespace: string; name: string } | undefined => {
  if (hr.spec?.chartRef) {
    return undefined;
  }
  const sourceRef = hr.spec?.chart?.spec?.sourceRef;
  const namespace = hr.metadata?.namespace;
  const name = hr.metadata?.name;
  if (!sourceRef?.kind || !namespace || !name) {
    return undefined;
  }
  return { namespace: sourceRef.namespace || namespace, name: `${namespace}-${name}` };
};

// True when hr's chart ultimately comes from (targetKind, targetNamespace,
// targetName) - either directly (spec.chart.spec.sourceRef, the source
// behind a HelmChartTemplate) or via an explicit spec.chartRef pointing at
// an existing HelmChart/OCIRepository object.
export const helmReleaseReferencesSource = (
  hr: HelmReleaseKind,
  targetKind: string,
  targetNamespace: string,
  targetName: string,
): boolean => {
  const consumerNamespace = hr.metadata?.namespace || '';
  if (matchesReference(hr.spec?.chart?.spec?.sourceRef, consumerNamespace, targetKind, targetNamespace, targetName)) {
    return true;
  }
  return matchesReference(hr.spec?.chartRef, consumerNamespace, targetKind, targetNamespace, targetName);
};

// True when hr's chart is targetHelmChart - either the object
// impliedHelmChartRef derives from its HelmChartTemplate, or an explicit
// chartRef naming it directly (the mechanism for several HelmReleases to
// share one HelmChart object).
export const helmReleaseReferencesHelmChart = (
  hr: HelmReleaseKind,
  targetNamespace: string,
  targetName: string,
): boolean => {
  const implied = impliedHelmChartRef(hr);
  if (implied) {
    return implied.namespace === targetNamespace && implied.name === targetName;
  }
  return matchesReference(hr.spec?.chartRef, hr.metadata?.namespace || '', 'HelmChart', targetNamespace, targetName);
};
