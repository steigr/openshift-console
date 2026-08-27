import * as React from 'react';

import { useHostnameStatuses } from '../../hooks/useHostnameStatuses';
import { DNSEndpointModel } from '../../models';
import { DNSEndpointKind } from '../../types';
import { hostnamesForDNSEndpoint } from '../../utils/hostnames';
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

// Called once for the whole (filtered) dataset - see GenericResourceList's
// useExtraColumns doc comment - so the live registry check below fires one
// batch of concurrency-capped requests (see useHostnameStatuses) instead of
// one per row independently.
const useDNSEndpointColumns = (data: DNSEndpointKind[]): ExtraColumn<DNSEndpointKind>[] => {
  const hostnames = React.useMemo(
    () => Array.from(new Set(data.flatMap(hostnamesForDNSEndpoint))),
    [data],
  );
  const [liveStatuses, liveLoading] = useHostnameStatuses(hostnames);

  return [
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
    {
      id: 'liveRegistryStatus',
      title: 'Live Registry Status',
      render: (obj) => {
        // Live, resolver-based cross-check of the registry TXT ownership
        // claim, distinct from the reconciliation-based "Managed" column
        // above - NOT authoritative on its own for a hostname on a private/
        // split-horizon zone the configured resolver can't see (same caveat
        // as isReconciled's doc comment, from the other direction).
        const names = hostnamesForDNSEndpoint(obj);
        if (names.length === 0) {
          return '-';
        }
        const anyManaged = names.some((h) => liveStatuses[h]?.managed);
        const owner = names.map((h) => liveStatuses[h]?.ownerId).find(Boolean);
        const anyError = names.map((h) => liveStatuses[h]?.error).find(Boolean);
        const tooltip = anyError
          ? anyError
          : owner
            ? `Owned by external-dns instance "${owner}"`
            : anyManaged
              ? 'Managed per the live registry TXT check'
              : 'No registry TXT ownership claim found by the live check';
        return <ManagedBadge loading={liveLoading} managed={anyManaged} tooltip={tooltip} />;
      },
    },
  ];
};

type ListProps = { namespace?: string };

export const DNSEndpointList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<DNSEndpointKind>
    model={DNSEndpointModel}
    namespace={namespace}
    useExtraColumns={useDNSEndpointColumns}
  />
);
