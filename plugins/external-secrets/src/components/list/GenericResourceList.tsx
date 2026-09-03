import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  getGroupVersionKindForModel,
  K8sResourceCommon,
  ListPageBody,
  ListPageFilter,
  ListPageHeader,
  ResourceLink,
  Timestamp,
  useK8sWatchResource,
  useListPageFilter,
} from '@openshift-console/dynamic-plugin-sdk';
import { EmptyState, EmptyStateBody } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';

import { ExternalSecretsModel } from '../../models';
import ActionsDropdown from '../actions/ActionsDropdown';
import { useResourceActions } from '../actions/useResourceActions';

export type ExtraColumn<T> = {
  id: string;
  title: string;
  render: (obj: T) => React.ReactNode;
};

type GenericResourceListProps<T extends K8sResourceCommon> = {
  model: ExternalSecretsModel;
  namespace?: string;
  extraColumns?: ExtraColumn<T>[];
  supportsForceRefresh?: boolean;
};

function ResourceRow<T extends K8sResourceCommon>({
  obj,
  model,
  showNamespace,
  extraColumns,
  supportsForceRefresh,
}: {
  obj: T;
  model: ExternalSecretsModel;
  showNamespace: boolean;
  extraColumns: ExtraColumn<T>[];
  supportsForceRefresh: boolean;
}) {
  const [actions] = useResourceActions(model, obj, { supportsForceRefresh });
  return (
    <Tr>
      <Td dataLabel="Name">
        <ResourceLink
          groupVersionKind={{ group: model.group, version: model.version, kind: model.kind }}
          name={obj.metadata?.name}
          namespace={obj.metadata?.namespace}
        />
      </Td>
      {showNamespace && (
        <Td dataLabel="Namespace">
          <ResourceLink kind="Namespace" name={obj.metadata?.namespace} />
        </Td>
      )}
      {extraColumns.map((c) => (
        <Td key={c.id} dataLabel={c.title}>
          {c.render(obj)}
        </Td>
      ))}
      <Td dataLabel="Created">
        <Timestamp timestamp={obj.metadata?.creationTimestamp} />
      </Td>
      <Td isActionCell>
        <ActionsDropdown actions={actions} isKebab />
      </Td>
    </Tr>
  );
}

function GenericResourceList<T extends K8sResourceCommon>({
  model,
  namespace,
  extraColumns = [],
  supportsForceRefresh = false,
}: GenericResourceListProps<T>) {
  const { t } = useTranslation('plugin__external-secrets-console-plugin');

  const watchResult = useK8sWatchResource<T[]>({
    groupVersionKind: getGroupVersionKindForModel({
      apiGroup: model.group,
      apiVersion: model.version,
      kind: model.kind,
    } as any),
    isList: true,
    namespaced: model.namespaced,
    namespace: model.namespaced ? namespace : undefined,
  });
  const [, loaded, loadError] = watchResult;

  const [allData, filtered, onFilterChange] = useListPageFilter(watchResult[0]);

  const showNamespace = model.namespaced && !namespace;

  return (
    <>
      <ListPageHeader title={model.labelPlural} />
      <ListPageBody>
        <ListPageFilter data={allData} loaded={loaded} onFilterChange={onFilterChange} />
        {loadError ? (
          <EmptyState>
            <EmptyStateBody>{String(loadError)}</EmptyStateBody>
          </EmptyState>
        ) : !loaded ? (
          <EmptyState>
            <EmptyStateBody>{t('Loading...')}</EmptyStateBody>
          </EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState>
            <EmptyStateBody>{t('No {{kind}} found', { kind: model.labelPlural })}</EmptyStateBody>
          </EmptyState>
        ) : (
          <Table aria-label={`${model.labelPlural} table`}>
            <Thead>
              <Tr>
                <Th>{t('Name')}</Th>
                {showNamespace && <Th>{t('Namespace')}</Th>}
                {extraColumns.map((c) => (
                  <Th key={c.id}>{c.title}</Th>
                ))}
                <Th>{t('Created')}</Th>
                <Th screenReaderText={t('Actions')} />
              </Tr>
            </Thead>
            <Tbody>
              {filtered.map((obj) => (
                <ResourceRow
                  key={obj.metadata?.uid || obj.metadata?.name}
                  obj={obj}
                  model={model}
                  showNamespace={showNamespace}
                  extraColumns={extraColumns}
                  supportsForceRefresh={supportsForceRefresh}
                />
              ))}
            </Tbody>
          </Table>
        )}
      </ListPageBody>
    </>
  );
}

export default GenericResourceList;
