import * as React from 'react';
import { DetailsItemComponentProps, ResourceLink, Timestamp } from '@openshift-console/dynamic-plugin-sdk';
import { Label, List, ListItem } from '@patternfly/react-core';

import { CertificateKind } from '../../types';
import { isPast } from '../../utils/duration';
import { decodeIDN } from '../../utils/punycode';

const CERT_MANAGER_GROUP = 'cert-manager.io';

// console.resource/details-item components for cert-manager.io/v1
// Certificate, registered in plugin-manifest.ts to add to the *default*
// Details tab's right column rather than owning a whole custom details
// page - each renders one field, so a resource without that field just
// omits its item instead of the whole page needing a fallback layout.

export const CommonNameItem: React.FC<DetailsItemComponentProps<CertificateKind>> = ({ obj }) =>
  <>{obj.spec?.commonName || '-'}</>;

const isWildcardSAN = (name: string): boolean => name === '*' || name.startsWith('*.');

export const SubjectAltNamesItem: React.FC<DetailsItemComponentProps<CertificateKind>> = ({ obj }) => {
  const raw = [...(obj.spec?.dnsNames || []), ...(obj.spec?.ipAddresses || [])];
  if (raw.length === 0) {
    return <>-</>;
  }
  // IP addresses pass through decodeIDN unchanged (no dots-as-labels
  // ambiguity in practice for the literal forms cert-manager accepts).
  const entries = raw
    .map((name) => ({ raw: name, display: decodeIDN(name) }))
    .sort((a, b) => a.display.localeCompare(b.display));

  return (
    <List isPlain>
      {entries.map(({ raw: rawName, display }) => (
        <ListItem key={rawName}>
          {isWildcardSAN(rawName) ? (
            display
          ) : (
            <a href={`https://${rawName}`} target="_blank" rel="noopener noreferrer">
              {display}
            </a>
          )}
        </ListItem>
      ))}
    </List>
  );
};

// issuerRef.kind defaults to "Issuer" and .group to "cert-manager.io" when
// omitted from the spec (cert-manager's own defaulting) - ClusterIssuer is
// cluster-scoped, Issuer lives in the Certificate's own namespace.
export const IssuerLinkItem: React.FC<DetailsItemComponentProps<CertificateKind>> = ({ obj }) => {
  const issuerRef = obj.spec?.issuerRef;
  if (!issuerRef?.name) {
    return <>-</>;
  }
  const kind = issuerRef.kind || 'Issuer';
  return (
    <ResourceLink
      groupVersionKind={{ group: issuerRef.group || CERT_MANAGER_GROUP, version: 'v1', kind }}
      name={issuerRef.name}
      namespace={kind === 'ClusterIssuer' ? undefined : obj.metadata?.namespace}
    />
  );
};

export const SecretLinkItem: React.FC<DetailsItemComponentProps<CertificateKind>> = ({ obj }) => {
  const secretName = obj.spec?.secretName;
  if (!secretName) {
    return <>-</>;
  }
  return (
    <ResourceLink
      groupVersionKind={{ group: '', version: 'v1', kind: 'Secret' }}
      name={secretName}
      namespace={obj.metadata?.namespace}
    />
  );
};

export const NotBeforeItem: React.FC<DetailsItemComponentProps<CertificateKind>> = ({ obj }) =>
  obj.status?.notBefore ? <Timestamp timestamp={obj.status.notBefore} /> : <>-</>;

export const NotAfterItem: React.FC<DetailsItemComponentProps<CertificateKind>> = ({ obj }) =>
  obj.status?.notAfter ? <Timestamp timestamp={obj.status.notAfter} /> : <>-</>;

// Flags a renewal as overdue once status.renewalTime is in the past -
// cert-manager should have already renewed by then.
export const RenewalTimeItem: React.FC<DetailsItemComponentProps<CertificateKind>> = ({ obj }) => {
  const renewalTime = obj.status?.renewalTime;
  if (!renewalTime) {
    return <>-</>;
  }
  return (
    <>
      <Timestamp timestamp={renewalTime} />
      {isPast(renewalTime) && (
        <>
          {' '}
          <Label color="red">Overdue</Label>
        </>
      )}
    </>
  );
};
