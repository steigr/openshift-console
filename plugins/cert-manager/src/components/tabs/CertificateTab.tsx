import * as React from 'react';
import { PageComponentProps } from '@openshift-console/dynamic-plugin-sdk';
import { PageSection, Title } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';

import { useCertificateLookup } from '../../hooks/useCertificateLookup';
import {
  DNSEndpointKind,
  HTTPRouteKind,
  IngressKind,
  ServiceKind,
  TLSRouteKind,
} from '../../types';
import {
  hostnamesForDNSEndpoint,
  hostnamesForHTTPRoute,
  hostnamesForIngress,
  hostnamesForService,
  hostnamesForTLSRoute,
} from '../../utils/hostnames';
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

// A "Certificate" horizontalNav tab body: derives the hostname(s) served by
// `obj` via `deriveHostnames`, probes each with the plugin's /api/v1/certcheck
// backend, and renders a compact per-hostname table of what's actually being
// served - issuer, root CA, remaining validity, key type/size.
function CertificateTabBody<T>({
  obj,
  deriveHostnames,
}: {
  obj: T;
  deriveHostnames: (obj: T) => string[];
}) {
  const hostnames = React.useMemo(() => (obj ? deriveHostnames(obj) : []), [obj, deriveHostnames]);
  const targets = React.useMemo(() => hostnames.map((hostname) => ({ hostname, port: 443 })), [
    hostnames,
  ]);
  const [results, loading] = useCertificateLookup(targets);

  if (hostnames.length === 0) {
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
          {hostnames.map((hostname) => {
            const result = results[`${hostname}:443`];
            return (
              <Tr key={hostname}>
                <Td dataLabel="Hostname">{hostname}</Td>
                <Td dataLabel="Status">
                  <CertificateSummary loading={loading} result={result} />
                </Td>
                <Td dataLabel="Issuer">{result?.issuer || '-'}</Td>
                <Td dataLabel="Root CA">{result?.rootCA || '-'}</Td>
                <Td dataLabel="Expires">
                  {result?.notAfter ? formatTimeUntil(result.notAfter) : '-'}
                </Td>
                <Td dataLabel="Key">{keyLabel(result?.keyAlgorithm, result?.keySize, result?.keyCurve)}</Td>
              </Tr>
            );
          })}
        </Tbody>
      </Table>
    </PageSection>
  );
}

export const IngressCertificateTab: React.FC<PageComponentProps<IngressKind>> = ({ obj }) => (
  <CertificateTabBody obj={obj} deriveHostnames={hostnamesForIngress} />
);

export const ServiceCertificateTab: React.FC<PageComponentProps<ServiceKind>> = ({ obj }) => (
  <CertificateTabBody obj={obj} deriveHostnames={hostnamesForService} />
);

export const HTTPRouteCertificateTab: React.FC<PageComponentProps<HTTPRouteKind>> = ({ obj }) => (
  <CertificateTabBody obj={obj} deriveHostnames={hostnamesForHTTPRoute} />
);

export const TLSRouteCertificateTab: React.FC<PageComponentProps<TLSRouteKind>> = ({ obj }) => (
  <CertificateTabBody obj={obj} deriveHostnames={hostnamesForTLSRoute} />
);

export const DNSEndpointCertificateTab: React.FC<PageComponentProps<DNSEndpointKind>> = ({
  obj,
}) => <CertificateTabBody obj={obj} deriveHostnames={hostnamesForDNSEndpoint} />;
