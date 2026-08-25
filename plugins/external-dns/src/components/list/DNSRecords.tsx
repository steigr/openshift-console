import * as React from 'react';
import { Label, LabelGroup, Spinner, Tooltip } from '@patternfly/react-core';

import { DNSEndpointEntry } from '../../types';

export const EndpointRecordsChips: React.FC<{ endpoints: DNSEndpointEntry[] }> = ({
  endpoints,
}) => {
  if (!endpoints || endpoints.length === 0) {
    return <>-</>;
  }
  return (
    <LabelGroup numLabels={5}>
      {endpoints.map((ep, idx) => (
        <Label key={`${ep.dnsName}-${ep.recordType}-${idx}`} color="blue">
          {ep.dnsName} ({ep.recordType}) → {(ep.targets || []).join(', ') || '-'}
        </Label>
      ))}
    </LabelGroup>
  );
};

export const ManagedBadge: React.FC<{
  loading: boolean;
  managed?: boolean;
  tooltip?: string;
}> = ({ loading, managed, tooltip }) => {
  if (loading) {
    return <Spinner size="sm" aria-label="Checking DNS ownership" />;
  }
  const label = (
    <Label color={managed ? 'green' : 'yellow'}>{managed ? 'Managed' : 'Unmanaged'}</Label>
  );
  return tooltip ? <Tooltip content={tooltip}>{label}</Tooltip> : label;
};
