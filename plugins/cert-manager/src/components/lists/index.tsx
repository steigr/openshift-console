import * as React from 'react';
import { ResourceLink, Timestamp } from '@openshift-console/dynamic-plugin-sdk';

import {
  BundleModel,
  ChallengeModel,
  CertificateModel,
  CertificateRequestModel,
  ClusterIssuerModel,
  IssuerModel,
  OrderModel,
} from '../../models';
import {
  BundleKind,
  CertificateKind,
  CertificateRequestKind,
  ChallengeKind,
  IssuerKind,
  OrderKind,
} from '../../types';
import { formatTimeUntil } from '../../utils/duration';
import { getIssuerType, getLatestCondition, getReadyCondition, getSyncedCondition } from '../../utils/certStatus';
import ConditionLabel from '../list/ConditionLabel';
import GenericResourceList, { ExtraColumn } from '../list/GenericResourceList';

const issuerRefColumn = <T extends CertificateKind | CertificateRequestKind | OrderKind>(): ExtraColumn<T> => ({
  id: 'issuer',
  title: 'Issuer',
  render: (obj) => obj.spec?.issuerRef?.name || '-',
});

const certificateColumns: ExtraColumn<CertificateKind>[] = [
  {
    id: 'ready',
    title: 'Ready',
    render: (obj) => <ConditionLabel condition={getReadyCondition(obj)} />,
  },
  {
    id: 'secret',
    title: 'Secret',
    render: (obj) =>
      obj.spec?.secretName ? (
        <ResourceLink
          groupVersionKind={{ group: '', version: 'v1', kind: 'Secret' }}
          name={obj.spec.secretName}
          namespace={obj.metadata?.namespace}
        />
      ) : (
        '-'
      ),
  },
  issuerRefColumn<CertificateKind>(),
  {
    id: 'notAfter',
    title: 'Not After',
    render: (obj) => (obj.status?.notAfter ? <Timestamp timestamp={obj.status.notAfter} /> : '-'),
  },
  {
    id: 'renews',
    title: 'Renews in',
    render: (obj) => formatTimeUntil(obj.status?.renewalTime),
  },
  {
    id: 'message',
    title: 'Message',
    render: (obj) => getLatestCondition(obj)?.message || '-',
  },
];

const certificateRequestColumns: ExtraColumn<CertificateRequestKind>[] = [
  {
    id: 'ready',
    title: 'Ready',
    render: (obj) => <ConditionLabel condition={getReadyCondition(obj)} />,
  },
  issuerRefColumn<CertificateRequestKind>(),
];

const issuerColumns: ExtraColumn<IssuerKind>[] = [
  {
    id: 'ready',
    title: 'Ready',
    render: (obj) => <ConditionLabel condition={getReadyCondition(obj)} />,
  },
  {
    id: 'type',
    title: 'Type',
    render: (obj) => getIssuerType(obj.spec),
  },
];

const orderColumns: ExtraColumn<OrderKind>[] = [
  {
    id: 'state',
    title: 'State',
    render: (obj) => obj.status?.state || '-',
  },
  {
    id: 'reason',
    title: 'Reason',
    render: (obj) => obj.status?.reason || '-',
  },
  issuerRefColumn<OrderKind>(),
];

const challengeColumns: ExtraColumn<ChallengeKind>[] = [
  {
    id: 'state',
    title: 'State',
    render: (obj) => obj.status?.state || '-',
  },
  {
    id: 'reason',
    title: 'Reason',
    render: (obj) => obj.status?.reason || '-',
  },
  {
    id: 'type',
    title: 'Type',
    render: (obj) => obj.spec?.type || '-',
  },
];

const bundleColumns: ExtraColumn<BundleKind>[] = [
  {
    id: 'synced',
    title: 'Synced',
    render: (obj) => <ConditionLabel condition={getSyncedCondition(obj)} trueText="Synced" falseText="NotSynced" />,
  },
  {
    id: 'target',
    title: 'Target',
    render: (obj) => {
      const target = obj.spec?.target;
      if (!target) {
        return '-';
      }
      if (target.configMap?.key) {
        return `ConfigMap: ${target.configMap.key}`;
      }
      if (target.secret?.key) {
        return `Secret: ${target.secret.key}`;
      }
      return '-';
    },
  },
];

type ListProps = { namespace?: string };

export const CertificateList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<CertificateKind>
    model={CertificateModel}
    namespace={namespace}
    useExtraColumns={() => certificateColumns}
  />
);

export const CertificateRequestList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<CertificateRequestKind>
    model={CertificateRequestModel}
    namespace={namespace}
    useExtraColumns={() => certificateRequestColumns}
  />
);

export const IssuerList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<IssuerKind>
    model={IssuerModel}
    namespace={namespace}
    useExtraColumns={() => issuerColumns}
  />
);

export const ClusterIssuerList: React.FC<ListProps> = () => (
  <GenericResourceList<IssuerKind> model={ClusterIssuerModel} useExtraColumns={() => issuerColumns} />
);

export const OrderList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<OrderKind>
    model={OrderModel}
    namespace={namespace}
    useExtraColumns={() => orderColumns}
  />
);

export const ChallengeList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<ChallengeKind>
    model={ChallengeModel}
    namespace={namespace}
    useExtraColumns={() => challengeColumns}
  />
);

export const BundleList: React.FC<ListProps> = () => (
  <GenericResourceList<BundleKind> model={BundleModel} useExtraColumns={() => bundleColumns} />
);
