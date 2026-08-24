import * as React from 'react';
import { Timestamp } from '@openshift-console/dynamic-plugin-sdk';
import { Label } from '@patternfly/react-core';

import {
  ClusterExternalSecretModel,
  ClusterPushSecretModel,
  ClusterSecretStoreModel,
  ExternalSecretModel,
  PushSecretModel,
  SecretStoreModel,
} from '../../models';
import { ExternalSecretKind, SecretStoreKind } from '../../types';
import { getProviderKey, getReadyCondition } from '../../utils/storeStatus';
import FreshnessChecked from '../list/FreshnessChecked';
import GenericResourceList, { ExtraColumn } from '../list/GenericResourceList';

const StatusLabel: React.FC<{ obj: SecretStoreKind }> = ({ obj }) => {
  const ready = getReadyCondition(obj);
  if (!ready) {
    return <>-</>;
  }
  const isReady = ready.status === 'True';
  return (
    <Label color={isReady ? 'green' : 'red'} title={ready.message}>
      {ready.reason || (isReady ? 'Ready' : 'NotReady')}
    </Label>
  );
};

const storeColumns: ExtraColumn<SecretStoreKind>[] = [
  {
    id: 'status',
    title: 'Status',
    render: (obj) => <StatusLabel obj={obj} />,
  },
  {
    id: 'capabilities',
    title: 'Capabilities',
    render: (obj) => obj.status?.capabilities || '-',
  },
  {
    id: 'provider',
    title: 'Provider',
    render: (obj) => getProviderKey(obj),
  },
];

const refreshColumns: ExtraColumn<ExternalSecretKind>[] = [
  {
    id: 'refreshTime',
    title: 'Last Refreshed',
    render: (obj) =>
      obj.status?.refreshTime ? <Timestamp timestamp={obj.status.refreshTime} /> : '-',
  },
  {
    id: 'freshnessChecked',
    title: 'Freshness Checked',
    render: (obj) => <FreshnessChecked timestamp={obj.status?.refreshTime} />
  },
];

type ListProps = { namespace?: string };

export const ExternalSecretList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<ExternalSecretKind>
    model={ExternalSecretModel}
    namespace={namespace}
    extraColumns={refreshColumns}
    supportsForceRefresh
  />
);

export const PushSecretList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList model={PushSecretModel} namespace={namespace} />
);

export const ClusterExternalSecretList: React.FC<ListProps> = () => (
  <GenericResourceList<ExternalSecretKind>
    model={ClusterExternalSecretModel}
    extraColumns={refreshColumns}
    supportsForceRefresh
  />
);

export const ClusterPushSecretList: React.FC<ListProps> = () => (
  <GenericResourceList model={ClusterPushSecretModel} />
);

export const SecretStoreList: React.FC<ListProps> = ({ namespace }) => (
  <GenericResourceList<SecretStoreKind>
    model={SecretStoreModel}
    namespace={namespace}
    extraColumns={storeColumns}
  />
);

export const ClusterSecretStoreList: React.FC<ListProps> = () => (
  <GenericResourceList<SecretStoreKind> model={ClusterSecretStoreModel} extraColumns={storeColumns} />
);
