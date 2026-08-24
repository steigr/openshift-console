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

export type ExternalSecretKind = K8sResourceCommon & {
  status?: {
    refreshTime?: string;
    conditions?: StoreCondition[];
  };
};
