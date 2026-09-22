import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

export type VolumeMount = { name: string; mountPath: string; readOnly?: boolean };

export type ContainerSpec = { name: string; volumeMounts?: VolumeMount[] };

export type PodKind = K8sResourceCommon & {
  spec?: {
    containers?: ContainerSpec[];
    initContainers?: ContainerSpec[];
    nodeName?: string;
  };
  status?: {
    phase?: string;
    containerStatuses?: { name: string; ready?: boolean; state?: Record<string, unknown> }[];
    ephemeralContainerStatuses?: { name: string }[];
  };
};
