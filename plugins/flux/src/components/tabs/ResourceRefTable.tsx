import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  K8sResourceCommon,
  ResourceLink,
  getGroupVersionKindForModel,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import { EmptyState, EmptyStateBody, PageSection, Title } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';

import { FluxModel } from '../../models';
import { Condition } from '../../types';
import { getReadyCondition } from '../../utils/status';
import ConditionLabel from '../list/ConditionLabel';

type ResourceWithConditions = K8sResourceCommon & { status?: { conditions?: Condition[] } };

export type ResourceRefRow = { model: FluxModel; obj: ResourceWithConditions };

// Shared read-only table for every cross-reference tab this plugin adds
// (GitRepository/HelmChart's Consumers, HelmRelease's Dependencies and
// Dependents) - no filter bar, no actions: these are views onto
// relationships between objects, not a place to manage the objects
// themselves. Kind is included since a single tab can list more than one
// kind of related object (e.g. GitRepository's Consumers mixes
// Kustomizations and HelmReleases).
export const ResourceRefTable: React.FC<{
  title: string;
  rows: ResourceRefRow[];
  loaded: boolean;
  emptyText: string;
}> = ({ title, rows, loaded, emptyText }) => {
  const { t } = useTranslation('plugin__flux-console-plugin');
  return (
    <PageSection>
      <Title headingLevel="h3">{title}</Title>
      {!loaded ? (
        <EmptyState>
          <EmptyStateBody>{t('Loading...')}</EmptyStateBody>
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>
          <EmptyStateBody>{emptyText}</EmptyStateBody>
        </EmptyState>
      ) : (
        <Table aria-label={title}>
          <Thead>
            <Tr>
              <Th>{t('Kind')}</Th>
              <Th>{t('Name')}</Th>
              <Th>{t('Namespace')}</Th>
              <Th>{t('Ready')}</Th>
            </Tr>
          </Thead>
          <Tbody>
            {rows.map(({ model, obj }) => (
              <Tr key={`${model.kind}/${obj.metadata?.namespace}/${obj.metadata?.name}`}>
                <Td dataLabel="Kind">{model.kind}</Td>
                <Td dataLabel="Name">
                  <ResourceLink
                    groupVersionKind={{ group: model.group, version: model.version, kind: model.kind }}
                    name={obj.metadata?.name}
                    namespace={obj.metadata?.namespace}
                  />
                </Td>
                <Td dataLabel="Namespace">
                  <ResourceLink kind="Namespace" name={obj.metadata?.namespace} />
                </Td>
                <Td dataLabel="Ready">
                  <ConditionLabel condition={getReadyCondition(obj)} />
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </PageSection>
  );
};

// Watches every object of model's kind across every namespace the logged-in
// user can see, rather than just the "owning" object's own namespace -
// referencing objects (consumers, dependents) are frequently elsewhere.
export const useClusterWideWatch = <T,>(model: FluxModel) => {
  const watchResult = useK8sWatchResource<T[]>({
    groupVersionKind: getGroupVersionKindForModel({
      apiGroup: model.group,
      apiVersion: model.version,
      kind: model.kind,
    } as any),
    isList: true,
    namespaced: model.namespaced,
  });
  const [data, loaded] = watchResult;
  return { data: data || [], loaded };
};
