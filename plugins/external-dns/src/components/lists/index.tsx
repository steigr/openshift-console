import * as React from 'react';

import { DNSEndpointModel } from '../../models';
import { DNSEndpointKind } from '../../types';
import { EndpointRecordsChips, ManagedBadge } from '../list/DNSRecords';
import GenericResourceList, { ExtraColumn } from '../list/GenericResourceList';

// "Managed" reflects whether external-dns' CRD source has reconciled this
// object (status.observedGeneration caught up with metadata.generation) -
// NOT a live DNS/registry lookup. A DNSEndpoint's targets are frequently on
// a private/split-horizon zone (internal provider, RFC1918 addresses) that a
// public DNS-over-HTTPS resolver can never see, so an external lookup would
// misreport a genuinely-managed record as unmanaged. Reconciliation state is
// the only signal available here that's accurate regardless of the zone's
// visibility.
const isReconciled = (obj: DNSEndpointKind): boolean => {
  const observedGeneration = obj.status?.observedGeneration;
  const generation = obj.metadata?.generation;
  return observedGeneration != null && generation != null && observedGeneration >= generation;
};

const useDNSEndpointColumns = (_data: DNSEndpointKind[]): ExtraColumn<DNSEndpointKind>[] => [
  {
    id: 'records',
    title: 'Records',
    render: (obj) => <EndpointRecordsChips endpoints={obj.spec?.endpoints || []} />,
  },
  {
    id: 'managed',
    title: 'Managed',
    render: (obj) => {
      const endpoints = obj.spec?.endpoints || [];
      if (endpoints.length === 0) {
        return '-';
      }
      const managed = isReconciled(obj);
      const tooltip = managed
        ? 'external-dns has reconciled this DNSEndpoint (status.observedGeneration matches metadata.generation)'
        : 'external-dns has not yet reconciled this DNSEndpoint';
      return <ManagedBadge loading={false} managed={managed} tooltip={tooltip} />;
    },
  },
];

type ListProps = { namespace?: string };

export const DNSEndpointList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<DNSEndpointKind>
    model={DNSEndpointModel}
    namespace={namespace}
    useExtraColumns={useDNSEndpointColumns}
  />
);
