import * as React from 'react';
import {
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
} from '@patternfly/react-core';

import {
  ClusterExternalSecretModel,
  ClusterSecretStoreModel,
  ExternalSecretModel,
  SecretStoreModel,
} from '../../models';
import { ClusterExternalSecretKind, ExternalSecretKind, SecretStoreKind } from '../../types';
import GenericDetailsPage from './GenericDetailsPage';
import SecretsTab from './SecretsTab';
import SecretStoreLink from './SecretStoreLink';

type DetailsPageProps = { name: string; namespace?: string };

export const ExternalSecretDetailsPage: React.FC<DetailsPageProps> = ({ name, namespace }) => (
  <GenericDetailsPage<ExternalSecretKind>
    model={ExternalSecretModel}
    name={name}
    namespace={namespace}
    supportsForceRefresh
    renderExtraDetails={(obj) => (
      <DescriptionListGroup>
        <DescriptionListTerm>Secret Store</DescriptionListTerm>
        <DescriptionListDescription>
          <SecretStoreLink storeRef={obj.spec?.secretStoreRef} namespace={obj.metadata?.namespace} />
        </DescriptionListDescription>
      </DescriptionListGroup>
    )}
  />
);

export const ClusterExternalSecretDetailsPage: React.FC<DetailsPageProps> = ({ name }) => (
  <GenericDetailsPage<ClusterExternalSecretKind>
    model={ClusterExternalSecretModel}
    name={name}
    supportsForceRefresh
    renderExtraDetails={(obj) => (
      <DescriptionListGroup>
        <DescriptionListTerm>Secret Store</DescriptionListTerm>
        <DescriptionListDescription>
          <SecretStoreLink storeRef={obj.spec?.externalSecretSpec?.secretStoreRef} />
        </DescriptionListDescription>
      </DescriptionListGroup>
    )}
  />
);

export const SecretStoreDetailsPage: React.FC<DetailsPageProps> = ({ name, namespace }) => (
  <GenericDetailsPage<SecretStoreKind>
    model={SecretStoreModel}
    name={name}
    namespace={namespace}
    extraTabs={(obj) => [
      {
        href: 'secrets',
        name: 'Secrets',
        component: () => <SecretsTab obj={obj} isCluster={false} />,
      },
    ]}
  />
);

export const ClusterSecretStoreDetailsPage: React.FC<DetailsPageProps> = ({ name }) => (
  <GenericDetailsPage<SecretStoreKind>
    model={ClusterSecretStoreModel}
    name={name}
    extraTabs={(obj) => [
      {
        href: 'secrets',
        name: 'Secrets',
        component: () => <SecretsTab obj={obj} isCluster />,
      },
    ]}
  />
);
