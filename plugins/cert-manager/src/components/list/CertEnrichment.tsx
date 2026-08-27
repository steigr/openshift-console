import * as React from 'react';
import { Label, LabelGroup, Spinner, Tooltip } from '@patternfly/react-core';

import { CertCheckResult, FamilyCertResult } from '../../types';
import { formatTimeUntil } from '../../utils/duration';

const keyLabel = (result?: { keyAlgorithm?: string; keySize?: number; keyCurve?: string }): string => {
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

// A single IPv4/IPv6 badge - green+filled when a TLS handshake succeeded
// over that family, grey+outline when it didn't (which is routine for a
// v4-only or v6-only host, not necessarily a problem on its own).
const FamilyConnectivityBadge: React.FC<{ label: 'IPv4' | 'IPv6'; connected: boolean }> = ({
  label,
  connected,
}) => (
  <Label color={connected ? 'green' : 'grey'} variant={connected ? 'filled' : 'outline'}>
    {label}
  </Label>
);

const familySummaryLine = (f: FamilyCertResult): string => {
  if (!f.connected) {
    return `${f.family}: not connected${f.error ? ` (${f.error})` : ''}`;
  }
  return `${f.family}: ${f.issuer || '-'} · expires ${f.notAfter || '-'} · ${keyLabel(f)}`;
};

// Compact column/panel rendering for a single hostname's live TLS
// certificate check - issuer, root CA, remaining validity, key details, and
// IPv4/IPv6 connectivity badges. When the two families actually disagree
// (result.familiesDiffer), a "families differ" badge surfaces each
// family's own view in its tooltip instead of just the shared one.
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

  const familyBadges = (
    <>
      <FamilyConnectivityBadge label="IPv4" connected={result.ipv4Connected} />
      <FamilyConnectivityBadge label="IPv6" connected={result.ipv6Connected} />
    </>
  );

  if (result.error) {
    return (
      <LabelGroup numLabels={3}>
        <Tooltip content={result.error}>
          <Label color="red">Unreachable</Label>
        </Tooltip>
        {familyBadges}
      </LabelGroup>
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
    <LabelGroup numLabels={6}>
      <Tooltip content={tooltip}>
        <Label color={result.expired ? 'red' : 'green'}>{expiryLabel}</Label>
      </Tooltip>
      <Tooltip content={tooltip}>
        <Label color="blue">{result.issuer || '-'}</Label>
      </Tooltip>
      <Tooltip content={tooltip}>
        <Label color="grey">{keyLabel(result)}</Label>
      </Tooltip>
      {familyBadges}
      {result.familiesDiffer && result.families && (
        <Tooltip content={result.families.map(familySummaryLine).join('\n')}>
          <Label color="orange">IPv4/IPv6 differ</Label>
        </Tooltip>
      )}
    </LabelGroup>
  );
};
