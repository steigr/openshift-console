import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

export type Condition = {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
};

export type CrossNamespaceObjectReference = {
  kind?: string;
  name?: string;
  namespace?: string;
};

export type Artifact = {
  revision?: string;
  lastUpdateTime?: string;
};

// secretRef on every Flux source kind is always local to the object's own
// namespace (no namespace field in the CRD schema, verified against a live
// cluster) - just a Secret name.
export type LocalObjectReference = {
  name?: string;
};

// A HelmRelease's spec.dependsOn - namespace defaults to the HelmRelease's
// own namespace when omitted (verified against a live cluster's CRD
// schema), same defaulting as CrossNamespaceObjectReference. Unlike
// sourceRef/chartRef there's no kind - a HelmRelease can only depend on
// other HelmReleases.
export type DependencyReference = {
  name?: string;
  namespace?: string;
  readyExpr?: string;
};

// --- group 1: applications ---------------------------------------------------

export type HelmReleaseKind = K8sResourceCommon & {
  spec?: {
    chart?: { spec?: { chart?: string; version?: string; sourceRef?: CrossNamespaceObjectReference } };
    chartRef?: CrossNamespaceObjectReference;
    dependsOn?: DependencyReference[];
    interval?: string;
    suspend?: boolean;
  };
  status?: {
    conditions?: Condition[];
    lastAttemptedRevision?: string;
    lastAppliedRevision?: string;
    history?: { chartVersion?: string; appVersion?: string }[];
    // "namespace/name" of the HelmChart CR this HelmRelease's source-controller
    // side creates/owns to fetch the chart - only set when using spec.chart,
    // not spec.chartRef (verified against a live cluster's CRD schema).
    helmChart?: string;
  };
};

export type HelmChartKind = K8sResourceCommon & {
  spec?: {
    chart?: string;
    version?: string;
    sourceRef?: CrossNamespaceObjectReference;
    interval?: string;
  };
  status?: {
    conditions?: Condition[];
    artifact?: Artifact;
  };
};

export type KustomizationKind = K8sResourceCommon & {
  spec?: {
    path?: string;
    sourceRef?: CrossNamespaceObjectReference;
    interval?: string;
    suspend?: boolean;
  };
  status?: {
    conditions?: Condition[];
    lastAppliedRevision?: string;
  };
};

// --- group 2: sources ----------------------------------------------------------

export type SourceRef = {
  branch?: string;
  tag?: string;
  semver?: string;
  name?: string;
  commit?: string;
};

export type GitRepositoryKind = K8sResourceCommon & {
  spec?: { url?: string; ref?: SourceRef; secretRef?: LocalObjectReference; interval?: string; suspend?: boolean };
  status?: { conditions?: Condition[]; artifact?: Artifact };
};

export type OCIRepositoryKind = K8sResourceCommon & {
  spec?: {
    url?: string;
    ref?: { tag?: string; semver?: string; digest?: string };
    secretRef?: LocalObjectReference;
    interval?: string;
    suspend?: boolean;
  };
  status?: { conditions?: Condition[]; artifact?: Artifact };
};

export type HelmRepositoryKind = K8sResourceCommon & {
  spec?: {
    url?: string;
    type?: string;
    secretRef?: LocalObjectReference;
    interval?: string;
    suspend?: boolean;
  };
  status?: { conditions?: Condition[]; artifact?: Artifact };
};

export type BucketKind = K8sResourceCommon & {
  spec?: {
    endpoint?: string;
    bucketName?: string;
    provider?: string;
    secretRef?: LocalObjectReference;
    interval?: string;
    suspend?: boolean;
  };
  status?: { conditions?: Condition[]; artifact?: Artifact };
};

// --- group 3: artifacts ---------------------------------------------------------

export type ArtifactGeneratorKind = K8sResourceCommon & {
  spec?: Record<string, unknown>;
  status?: { conditions?: Condition[] };
};

export type ExternalArtifactKind = K8sResourceCommon & {
  spec?: Record<string, unknown>;
  status?: { conditions?: Condition[]; artifact?: Artifact };
};

// --- group 4: image automation --------------------------------------------------

export type ImageRepositoryKind = K8sResourceCommon & {
  spec?: { image?: string; interval?: string; suspend?: boolean };
  status?: { conditions?: Condition[] };
};

export type ImagePolicyKind = K8sResourceCommon & {
  spec?: { imageRepositoryRef?: CrossNamespaceObjectReference };
  status?: { conditions?: Condition[]; latestRef?: { tag?: string; digest?: string } };
};

export type ImageUpdateAutomationKind = K8sResourceCommon & {
  spec?: { interval?: string; suspend?: boolean };
  status?: { conditions?: Condition[]; lastAutomationRunTime?: string };
};

// --- group 5: notification -------------------------------------------------------

export type ProviderKind = K8sResourceCommon & {
  spec?: { type?: string; address?: string; suspend?: boolean };
  status?: { conditions?: Condition[] };
};

export type ReceiverKind = K8sResourceCommon & {
  spec?: { type?: string; suspend?: boolean };
  status?: { conditions?: Condition[]; webhookPath?: string };
};

export type AlertKind = K8sResourceCommon & {
  spec?: { providerRef?: CrossNamespaceObjectReference; eventSeverity?: string; suspend?: boolean };
  status?: { conditions?: Condition[] };
};

export type FluxComponentStatus = {
  name?: string;
  ready?: boolean;
  status?: string;
  image?: string;
};

export type FluxReportKind = K8sResourceCommon & {
  spec?: {
    distribution?: { version?: string; status?: string; entitlement?: string; managedBy?: string };
    cluster?: { platform?: string; nodes?: number; serverVersion?: string };
    operator?: { platform?: string };
    components?: FluxComponentStatus[];
  };
  status?: { conditions?: Condition[] };
};

// --- group 6: operator ------------------------------------------------------------

export type FluxInstanceKind = K8sResourceCommon & {
  spec?: { distribution?: { version?: string }; cluster?: { networkPolicy?: boolean } };
  status?: { conditions?: Condition[]; lastAppliedRevision?: string };
};

export type ResourceSetKind = K8sResourceCommon & {
  spec?: { resources?: unknown[] };
  status?: { conditions?: Condition[]; inventory?: { entries?: unknown[] } };
};

export type ResourceSetInputProviderKind = K8sResourceCommon & {
  spec?: { type?: string };
  status?: { conditions?: Condition[]; exportedInputs?: unknown[] };
};
