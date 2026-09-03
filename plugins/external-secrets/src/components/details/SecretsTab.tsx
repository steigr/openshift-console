import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { ResourceLink, Timestamp, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { EmptyState, EmptyStateBody, PageSection } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';

import { ExternalSecretModel } from '../../models';
import { ExternalSecretKind, SecretStoreKind } from '../../types';

type SecretsTabProps = {
  obj: SecretStoreKind;
  isCluster: boolean;
};

const SecretsTab: React.FC<SecretsTabProps> = ({ obj, isCluster }) => {
  const { t } = useTranslation('plugin__external-secrets-console-plugin');

  const [items, loaded, loadError] = useK8sWatchResource<ExternalSecretKind[]>({
    groupVersionKind: {
      group: ExternalSecretModel.group,
      version: ExternalSecretModel.version,
      kind: ExternalSecretModel.kind,
    },
    isList: true,
    namespace: isCluster ? undefined : obj.metadata?.namespace,
  });

  const expectedKind = isCluster ? 'ClusterSecretStore' : 'SecretStore';
  const matching = (items || []).filter((es) => {
    const ref = es.spec?.secretStoreRef;
    return ref?.name === obj.metadata?.name && (ref?.kind || 'SecretStore') === expectedKind;
  });

  return (
    <PageSection>
      {loadError ? (
        <EmptyState>
          <EmptyStateBody>{String(loadError)}</EmptyStateBody>
        </EmptyState>
      ) : !loaded ? null : matching.length === 0 ? (
        <EmptyState>
          <EmptyStateBody>{t('No ExternalSecrets reference this store.')}</EmptyStateBody>
        </EmptyState>
      ) : (
        <Table aria-label={t('ExternalSecrets')}>
          <Thead>
            <Tr>
              <Th>{t('Name')}</Th>
              {isCluster && <Th>{t('Namespace')}</Th>}
              <Th>{t('Last Refreshed')}</Th>
              <Th>{t('Created')}</Th>
            </Tr>
          </Thead>
          <Tbody>
            {matching.map((es) => (
              <Tr key={es.metadata?.uid || es.metadata?.name}>
                <Td dataLabel="Name">
                  <ResourceLink
                    groupVersionKind={{
                      group: ExternalSecretModel.group,
                      version: ExternalSecretModel.version,
                      kind: ExternalSecretModel.kind,
                    }}
                    name={es.metadata?.name}
                    namespace={es.metadata?.namespace}
                  />
                </Td>
                {isCluster && (
                  <Td dataLabel="Namespace">
                    <ResourceLink kind="Namespace" name={es.metadata?.namespace} />
                  </Td>
                )}
                <Td dataLabel="Last Refreshed">
                  {es.status?.refreshTime ? <Timestamp timestamp={es.status.refreshTime} /> : '-'}
                </Td>
                <Td dataLabel="Created">
                  <Timestamp timestamp={es.metadata?.creationTimestamp} />
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </PageSection>
  );
};

export default SecretsTab;
