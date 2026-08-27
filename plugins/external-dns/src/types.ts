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

// --- backend inspect API -----------------------------------------------------

// The lightweight, cached registry-ownership check for one hostname - see
// api/lookup.go's HostnameResult. Used for the DNSEndpointList's live
// registry-status column, which only needs Managed/OwnerID, not the fuller
// per-record view DNSSettingsResult below carries.
export type HostnameResult = {
  hostname: string;
  managed: boolean;
  ownerId?: string;
  addresses?: string[];
  error?: string;
};

// --- backend dns-settings API -----------------------------------------------

export type DNSRecordType = 'A' | 'AAAA' | 'CNAME' | string;

export type DNSRecord = {
  type: DNSRecordType;
  value: string;
  ttl: number;
};

// The live "DNS Settings" view for one hostname: external-dns registry
// ownership (same shape the plugin's live-status column uses) plus every
// A/AAAA/CNAME record actually backing it, each with its real TTL - see
// api/dnssettings.go's DNSSettingsResult.
export type DNSSettingsResult = {
  hostname: string;
  managed: boolean;
  ownerId?: string;
  records?: DNSRecord[];
  error?: string;
};
