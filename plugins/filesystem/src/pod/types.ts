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

/** Per-container browser defaults, keyed by container name. */
export type FilesConfig = Record<string, { home?: string }>;

export const FILES_CONFIG_ANNOTATION = 'files.okd.io/config';

/** A malformed or absent annotation just means no container has a configured home. */
export const parseFilesConfig = (annotations?: Record<string, string>): FilesConfig => {
  const raw = annotations?.[FILES_CONFIG_ANNOTATION];
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as FilesConfig) : {};
  } catch {
    return {};
  }
};

/** The path the browser should open on for a container; "/" when unset or invalid. */
export const homePathFor = (config: FilesConfig, container: string): string => {
  const home = config[container]?.home;
  if (typeof home !== 'string' || !home.startsWith('/')) {
    return '/';
  }
  const trimmed = home.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
};
