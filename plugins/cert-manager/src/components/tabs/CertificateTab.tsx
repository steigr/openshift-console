import * as React from 'react';
import { K8sResourceCommon, PageComponentProps } from '@openshift-console/dynamic-plugin-sdk';
import { PageSection, Title } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';

import { useCertInfo } from '../../hooks/useCertInfo';
import { formatTimeUntil } from '../../utils/duration';
import { CertificateSummary } from '../list/CertEnrichment';

const keyLabel = (keyAlgorithm?: string, keySize?: number, keyCurve?: string): string => {
  if (!keyAlgorithm) {
    return '-';
  }
  if (keyAlgorithm === 'RSA' && keySize) {
    return `RSA-${keySize}`;
  }
  if (keyAlgorithm === 'ECDSA' && keyCurve) {
    return `ECDSA (${keyCurve})`;
  }
  return keyAlgorithm;
};

// A "Certificate" horizontalNav tab body: asks the plugin's
// /api/v1/inspect/ns/{namespace}/{gvk}/{name} backend to fetch `obj` itself
// (by group/version/kind + namespace/name), derive its hostname(s)
// server-side, and probe each -
// then renders a compact per-hostname table of what's actually being
// served (issuer, root CA, remaining validity, key type/size). Fetching
// and hostname-derivation both happen backend-side so this component only
// ever needs the object's identity, not its full spec shape.
function CertificateTabBody({
  obj,
  group,
  version,
  kind,
}: {
  obj: K8sResourceCommon;
  group: string;
  version: string;
  kind: string;
}) {
  const namespace = obj?.metadata?.namespace;
  const name = obj?.metadata?.name;

  const target = React.useMemo(
    () => (name ? { group, version, kind, namespace, name } : undefined),
    [group, version, kind, namespace, name],
  );
  const [results, loading] = useCertInfo(target);

  if (!loading && results.length === 0) {
    return (
      <PageSection>
        <Title headingLevel="h3">Certificate</Title>
        <p>No hostname could be determined for this resource.</p>
      </PageSection>
    );
  }

  return (
    <PageSection>
      <Title headingLevel="h3">Certificate</Title>
      <Table aria-label="Live TLS certificate details">
        <Thead>
          <Tr>
            <Th>Hostname</Th>
            <Th>Status</Th>
            <Th>Issuer</Th>
            <Th>Root CA</Th>
            <Th>Expires</Th>
            <Th>Key</Th>
          </Tr>
        </Thead>
        <Tbody>
          {loading && results.length === 0 && (
            <Tr>
              <Td dataLabel="Hostname" colSpan={6}>
                <CertificateSummary loading result={undefined} />
              </Td>
            </Tr>
          )}
          {results.map((result) => (
            <Tr key={`${result.hostname || 'unknown'}:${result.port || ''}`}>
              <Td dataLabel="Hostname">{result.hostname || '-'}</Td>
              <Td dataLabel="Status">
                <CertificateSummary
                  loading={loading}
                  result={result.resourceError ? undefined : result}
                />
              </Td>
              <Td dataLabel="Issuer">{result.issuer || result.resourceError || '-'}</Td>
              <Td dataLabel="Root CA">{result.rootCA || '-'}</Td>
              <Td dataLabel="Expires">{result.notAfter ? formatTimeUntil(result.notAfter) : '-'}</Td>
              <Td dataLabel="Key">{keyLabel(result.keyAlgorithm, result.keySize, result.keyCurve)}</Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </PageSection>
  );
}

export const IngressCertificateTab: React.FC<PageComponentProps<K8sResourceCommon>> = ({ obj }) => (
  <CertificateTabBody obj={obj} group="networking.k8s.io" version="v1" kind="Ingress" />
);

export const ServiceCertificateTab: React.FC<PageComponentProps<K8sResourceCommon>> = ({ obj }) => (
  <CertificateTabBody obj={obj} group="" version="v1" kind="Service" />
);

export const HTTPRouteCertificateTab: React.FC<PageComponentProps<K8sResourceCommon>> = ({ obj }) => (
  <CertificateTabBody obj={obj} group="gateway.networking.k8s.io" version="v1" kind="HTTPRoute" />
);

export const TLSRouteCertificateTab: React.FC<PageComponentProps<K8sResourceCommon>> = ({ obj }) => (
  <CertificateTabBody obj={obj} group="gateway.networking.k8s.io" version="v1alpha2" kind="TLSRoute" />
);

export const GRPCRouteCertificateTab: React.FC<PageComponentProps<K8sResourceCommon>> = ({ obj }) => (
  <CertificateTabBody obj={obj} group="gateway.networking.k8s.io" version="v1" kind="GRPCRoute" />
);

export const DNSEndpointCertificateTab: React.FC<PageComponentProps<K8sResourceCommon>> = ({ obj }) => (
  <CertificateTabBody obj={obj} group="externaldns.k8s.io" version="v1alpha1" kind="DNSEndpoint" />
);
