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
import { Table, Tbody, Td, Th, Thead, ThProps, Tr } from '@patternfly/react-table';

import { FluxModel } from '../../models';
import ActionsDropdown from '../actions/ActionsDropdown';
import { useResourceActions } from '../actions/useResourceActions';

export type ExtraColumn<T> = {
  id: string;
  title: string;
  render: (obj: T) => React.ReactNode;
  // Omit for a column whose values are a fixed/enum-like set rendered as a
  // badge or icon rather than free text (e.g. the Ready column) - leaving
  // it unset makes that column's header unsortable instead of sorting on
  // something that wouldn't be meaningful to compare.
  sortValue?: (obj: T) => string | number | undefined;
};

type ColumnDef<T> = ExtraColumn<T>;

type GenericResourceListProps<T extends K8sResourceCommon> = {
  model: FluxModel;
  namespace?: string;
  useExtraColumns?: (data: T[]) => ExtraColumn<T>[];
};

function ResourceRow<T extends K8sResourceCommon>({
  obj,
  model,
  columns,
}: {
  obj: T;
  model: FluxModel;
  columns: ColumnDef<T>[];
}) {
  const [actions] = useResourceActions(model, obj);
  return (
    <Tr>
      {columns.map((c) => (
        <Td key={c.id} dataLabel={c.title}>
          {c.render(obj)}
        </Td>
      ))}
      <Td isActionCell>
        <ActionsDropdown actions={actions} isKebab />
      </Td>
    </Tr>
  );
}

function GenericResourceList<T extends K8sResourceCommon>({
  model,
  namespace,
  useExtraColumns = () => [],
}: GenericResourceListProps<T>) {
  const { t } = useTranslation('plugin__flux-console-plugin');

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
  const extraColumns = useExtraColumns(allData);

  const showNamespace = model.namespaced && !namespace;

  const columns = React.useMemo<ColumnDef<T>[]>(() => {
    const nameColumn: ColumnDef<T> = {
      id: 'name',
      title: t('Name'),
      sortValue: (obj) => obj.metadata?.name,
      render: (obj) => (
        <ResourceLink
          groupVersionKind={{ group: model.group, version: model.version, kind: model.kind }}
          name={obj.metadata?.name}
          namespace={obj.metadata?.namespace}
        />
      ),
    };
    const namespaceColumn: ColumnDef<T> = {
      id: 'namespace',
      title: t('Namespace'),
      sortValue: (obj) => obj.metadata?.namespace,
      render: (obj) => <ResourceLink kind="Namespace" name={obj.metadata?.namespace} />,
    };
    const createdColumn: ColumnDef<T> = {
      id: 'created',
      title: t('Created'),
      sortValue: (obj) => (obj.metadata?.creationTimestamp ? Date.parse(obj.metadata.creationTimestamp) : undefined),
      render: (obj) => <Timestamp timestamp={obj.metadata?.creationTimestamp} />,
    };
    return [nameColumn, ...(showNamespace ? [namespaceColumn] : []), ...extraColumns, createdColumn];
  }, [t, model, showNamespace, extraColumns]);

  const [activeSortIndex, setActiveSortIndex] = React.useState<number | undefined>(undefined);
  const [activeSortDirection, setActiveSortDirection] = React.useState<'asc' | 'desc'>('asc');

  const sorted = React.useMemo(() => {
    const column = activeSortIndex !== undefined ? columns[activeSortIndex] : undefined;
    if (!column?.sortValue) {
      return filtered;
    }
    const direction = activeSortDirection === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const valueA = column.sortValue!(a);
      const valueB = column.sortValue!(b);
      if (valueA === undefined && valueB === undefined) {
        return 0;
      }
      if (valueA === undefined) {
        return 1;
      }
      if (valueB === undefined) {
        return -1;
      }
      if (typeof valueA === 'number' && typeof valueB === 'number') {
        return (valueA - valueB) * direction;
      }
      return String(valueA).localeCompare(String(valueB)) * direction;
    });
  }, [filtered, columns, activeSortIndex, activeSortDirection]);

  const getSortParams = (columnIndex: number): ThProps['sort'] | undefined =>
    columns[columnIndex]?.sortValue
      ? {
          sortBy: { index: activeSortIndex, direction: activeSortDirection },
          onSort: (_event, index, direction) => {
            setActiveSortIndex(index);
            setActiveSortDirection(direction);
          },
          columnIndex,
        }
      : undefined;

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
                {columns.map((c, index) => (
                  <Th key={c.id} sort={getSortParams(index)}>
                    {c.title}
                  </Th>
                ))}
                <Th screenReaderText={t('Actions')} />
              </Tr>
            </Thead>
            <Tbody>
              {sorted.map((obj) => (
                <ResourceRow key={obj.metadata?.uid || obj.metadata?.name} obj={obj} model={model} columns={columns} />
              ))}
            </Tbody>
          </Table>
        )}
      </ListPageBody>
    </>
  );
}

export default GenericResourceList;
