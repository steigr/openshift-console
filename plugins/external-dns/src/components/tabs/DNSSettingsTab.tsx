import * as React from 'react';
import { K8sResourceCommon, PageComponentProps } from '@openshift-console/dynamic-plugin-sdk';
import { Label, PageSection, Spinner, Title, Tooltip } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';

import { useDNSSettings } from '../../hooks/useDNSSettings';
import { DNSSettingsResult } from '../../types';
import {
  hostnamesForDNSEndpoint,
  hostnamesForIngress,
  hostnamesForRoute,
  hostnamesForService,
} from '../../utils/hostnames';

const ManagedLabel: React.FC<{ result?: DNSSettingsResult }> = ({ result }) => {
  if (!result) {
    return <>-</>;
  }
  if (result.error) {
    return (
      <Tooltip content={result.error}>
        <Label color="red">Unreachable</Label>
      </Tooltip>
    );
  }
  const label = <Label color={result.managed ? 'green' : 'yellow'}>{result.managed ? 'Managed' : 'Unmanaged'}</Label>;
  return result.ownerId ? (
    <Tooltip content={`Owned by external-dns instance "${result.ownerId}"`}>{label}</Tooltip>
  ) : (
    label
  );
};

// A "DNS Settings" horizontalNav tab body: derives `obj`'s hostname(s)
// client-side (this plugin has no backend k8s client - see
// utils/hostnames.ts), then asks the plugin's
// /api/v1/dns-settings/{resolver}/{hostname} backend for each one's live
// external-dns registry ownership plus its actual A/AAAA/CNAME records and
// their real TTLs.
function DNSSettingsTabBody({ hostnames }: { hostnames: string[] }) {
  const [results, loading] = useDNSSettings(hostnames);

  if (hostnames.length === 0) {
    return (
      <PageSection>
        <Title headingLevel="h3">DNS Settings</Title>
        <p>No hostname could be determined for this resource.</p>
      </PageSection>
    );
  }

  return (
    <PageSection>
      <Title headingLevel="h3">DNS Settings</Title>
      {hostnames.map((hostname) => {
        const result = results[hostname];
        return (
          <div key={hostname} style={{ marginBottom: 'var(--pf-t--global--spacer--lg, 24px)' }}>
            <Title headingLevel="h4">
              {hostname} <ManagedLabel result={result} />
            </Title>
            <Table aria-label={`DNS records for ${hostname}`}>
              <Thead>
                <Tr>
                  <Th>Type</Th>
                  <Th>Value</Th>
                  <Th>TTL</Th>
                </Tr>
              </Thead>
              <Tbody>
                {loading && !result && (
                  <Tr>
                    <Td colSpan={3}>
                      <Spinner size="sm" aria-label="Resolving DNS records" />
                    </Td>
                  </Tr>
                )}
                {result && (result.records || []).length === 0 && !result.error && (
                  <Tr>
                    <Td colSpan={3}>No records found</Td>
                  </Tr>
                )}
                {(result?.records || []).map((rec, idx) => (
                  <Tr key={`${rec.type}-${rec.value}-${idx}`}>
                    <Td dataLabel="Type">{rec.type}</Td>
                    <Td dataLabel="Value">{rec.value}</Td>
                    <Td dataLabel="TTL">{rec.ttl}s</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </div>
        );
      })}
    </PageSection>
  );
}

export const IngressDNSSettingsTab: React.FC<PageComponentProps<K8sResourceCommon>> = ({ obj }) => (
  <DNSSettingsTabBody hostnames={hostnamesForIngress(obj)} />
);

export const ServiceDNSSettingsTab: React.FC<PageComponentProps<K8sResourceCommon>> = ({ obj }) => (
  <DNSSettingsTabBody hostnames={hostnamesForService(obj)} />
);

export const HTTPRouteDNSSettingsTab: React.FC<PageComponentProps<K8sResourceCommon>> = ({ obj }) => (
  <DNSSettingsTabBody hostnames={hostnamesForRoute(obj)} />
);

export const TLSRouteDNSSettingsTab: React.FC<PageComponentProps<K8sResourceCommon>> = ({ obj }) => (
  <DNSSettingsTabBody hostnames={hostnamesForRoute(obj)} />
);

export const GRPCRouteDNSSettingsTab: React.FC<PageComponentProps<K8sResourceCommon>> = ({ obj }) => (
  <DNSSettingsTabBody hostnames={hostnamesForRoute(obj)} />
);

export const DNSEndpointDNSSettingsTab: React.FC<PageComponentProps<K8sResourceCommon>> = ({ obj }) => (
  <DNSSettingsTabBody hostnames={hostnamesForDNSEndpoint(obj)} />
);
