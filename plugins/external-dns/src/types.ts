import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

export type DNSEndpointEntry = {
  dnsName?: string;
  recordType?: string;
  recordTTL?: number;
  targets?: string[];
  labels?: Record<string, string>;
  setIdentifier?: string;
};

export type DNSEndpointKind = K8sResourceCommon & {
  spec?: {
    endpoints?: DNSEndpointEntry[];
  };
  status?: {
    observedGeneration?: number;
  };
};
