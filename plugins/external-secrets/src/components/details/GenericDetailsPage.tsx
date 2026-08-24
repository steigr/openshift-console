import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  HorizontalNav,
  K8sResourceCommon,
  NavPage,
  ResourceEventStream,
  ResourceIcon,
  ResourceYAMLEditor,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import { EmptyState, EmptyStateBody, Flex, Title } from '@patternfly/react-core';

import { ExternalSecretsModel } from '../../models';
import ActionsDropdown from '../actions/ActionsDropdown';
import { useResourceActions } from '../actions/useResourceActions';
import DetailsTab from './DetailsTab';

type GenericDetailsPageProps<T extends K8sResourceCommon> = {
  model: ExternalSecretsModel;
  name: string;
  namespace?: string;
  supportsForceRefresh?: boolean;
  renderExtraDetails?: (obj: T) => React.ReactNode;
  extraTabs?: (obj: T) => NavPage[];
};

function GenericDetailsPage<T extends K8sResourceCommon>({
  model,
  name,
  namespace,
  supportsForceRefresh = false,
  renderExtraDetails,
  extraTabs,
}: GenericDetailsPageProps<T>) {
  const { t } = useTranslation('plugin__external-secrets');

  const [obj, loaded, loadError] = useK8sWatchResource<T>({
    groupVersionKind: { group: model.group, version: model.version, kind: model.kind },
    name,
    namespace: model.namespaced ? namespace : undefined,
  });

  const [actions] = useResourceActions(
    model,
    obj || ({ metadata: { name, namespace } } as T),
    { supportsForceRefresh },
  );

  if (loadError) {
    return (
      <EmptyState>
        <EmptyStateBody>{String(loadError)}</EmptyStateBody>
      </EmptyState>
    );
  }

  if (!loaded || !obj) {
    return null;
  }

  const pages: NavPage[] = [
    {
      href: '',
      name: t('Details'),
      component: () => <DetailsTab<T> obj={obj} renderExtra={renderExtraDetails} />,
    },
    {
      href: 'yaml',
      name: t('YAML'),
      component: () => <ResourceYAMLEditor initialResource={obj} />,
    },
    {
      href: 'events',
      name: t('Events'),
      component: () => <ResourceEventStream resource={obj} />,
    },
    ...(extraTabs ? extraTabs(obj) : []),
  ];

  return (
    <>
      <Flex justifyContent={{ default: 'justifyContentSpaceBetween' }} className="pf-v6-u-p-md">
        <Title headingLevel="h1">
          <ResourceIcon groupVersionKind={{ group: model.group, version: model.version, kind: model.kind }} />
          {name}
        </Title>
        <ActionsDropdown actions={actions} />
      </Flex>
      <HorizontalNav pages={pages} resource={obj} />
    </>
  );
}

export default GenericDetailsPage;
