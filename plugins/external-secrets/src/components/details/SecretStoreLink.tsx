import * as React from 'react';
import { ResourceLink } from '@openshift-console/dynamic-plugin-sdk';

import { ClusterSecretStoreModel, SecretStoreModel } from '../../models';
import { SecretStoreRef } from '../../types';

type SecretStoreLinkProps = {
  storeRef?: SecretStoreRef;
  namespace?: string;
};

const SecretStoreLink: React.FC<SecretStoreLinkProps> = ({ storeRef, namespace }) => {
  if (!storeRef?.name) {
    return <>-</>;
  }

  const kind = storeRef.kind || 'SecretStore';

  if (kind === 'ClusterSecretStore') {
    return (
      <ResourceLink
        groupVersionKind={{
          group: ClusterSecretStoreModel.group,
          version: ClusterSecretStoreModel.version,
          kind: ClusterSecretStoreModel.kind,
        }}
        name={storeRef.name}
      />
    );
  }

  if (namespace) {
    return (
      <ResourceLink
        groupVersionKind={{
          group: SecretStoreModel.group,
          version: SecretStoreModel.version,
          kind: SecretStoreModel.kind,
        }}
        name={storeRef.name}
        namespace={namespace}
      />
    );
  }

  return (
    <>
      {storeRef.name} ({kind})
    </>
  );
};

export default SecretStoreLink;
