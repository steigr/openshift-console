import * as React from 'react';
import { Label, LabelGroup, Spinner, Tooltip } from '@patternfly/react-core';

import { CertCheckResult } from '../../types';
import { formatTimeUntil } from '../../utils/duration';

const keyLabel = (result?: CertCheckResult): string => {
  if (!result || !result.keyAlgorithm) {
    return '-';
  }
  if (result.keyAlgorithm === 'RSA' && result.keySize) {
    return `RSA-${result.keySize}`;
  }
  if (result.keyAlgorithm === 'ECDSA' && result.keyCurve) {
    return `ECDSA (${result.keyCurve})`;
  }
  return result.keyAlgorithm;
};

// Compact column/panel rendering for a single hostname's live TLS
// certificate check - issuer, root CA, remaining validity, and key details.
export const CertificateSummary: React.FC<{
  loading: boolean;
  result?: CertCheckResult;
}> = ({ loading, result }) => {
  if (loading && !result) {
    return <Spinner size="sm" aria-label="Checking certificate" />;
  }
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

  const expiryLabel = result.expired ? 'expired' : `expires in ${formatTimeUntil(result.notAfter)}`;
  const tooltip = [
    `Subject: ${result.subject || '-'}`,
    `Issuer: ${result.issuer || '-'}`,
    `Root CA: ${result.rootCA || '-'}`,
    `Not after: ${result.notAfter || '-'}`,
    `Key: ${keyLabel(result)}`,
  ].join('\n');

  return (
    <Tooltip content={tooltip}>
      <LabelGroup numLabels={4}>
        <Label color={result.expired ? 'red' : 'green'}>{expiryLabel}</Label>
        <Label color="blue">{result.issuer || '-'}</Label>
        <Label color="grey">{keyLabel(result)}</Label>
      </LabelGroup>
    </Tooltip>
  );
};

// Renders a per-hostname list of CertificateSummary rows, for resources
// (Ingress, Service, HTTPRoute, ...) that may expose several hostnames.
export const CertificateEnrichmentList: React.FC<{
  hostnames: string[];
  loading: boolean;
  results: Record<string, CertCheckResult>;
}> = ({ hostnames, loading, results }) => {
  if (!hostnames || hostnames.length === 0) {
    return <>-</>;
  }
  return (
    <>
      {hostnames.map((hostname) => (
        <div key={hostname} style={{ marginBottom: 'var(--pf-t--global--spacer--sm, 4px)' }}>
          <strong>{hostname}</strong>{' '}
          <CertificateSummary loading={loading} result={results[`${hostname}:443`]} />
        </div>
      ))}
    </>
  );
};
