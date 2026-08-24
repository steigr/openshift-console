import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

export type StoreCondition = {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
};

export type SecretStoreKind = K8sResourceCommon & {
  spec?: {
    provider?: Record<string, unknown>;
  };
  status?: {
    conditions?: StoreCondition[];
    capabilities?: string;
  };
};

export type SecretStoreRef = {
  name: string;
  kind?: 'SecretStore' | 'ClusterSecretStore';
};

export type ExternalSecretKind = K8sResourceCommon & {
  spec?: {
    secretStoreRef?: SecretStoreRef;
  };
  status?: {
    refreshTime?: string;
    conditions?: StoreCondition[];
  };
};

export type ClusterExternalSecretKind = K8sResourceCommon & {
  spec?: {
    externalSecretSpec?: {
      secretStoreRef?: SecretStoreRef;
    };
  };
  status?: {
    conditions?: StoreCondition[];
  };
};
