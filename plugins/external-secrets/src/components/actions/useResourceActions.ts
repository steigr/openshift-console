import {
  Action,
  k8sPatch,
  K8sResourceCommon,
  useAnnotationsModal,
  useDeleteModal,
  useK8sModel,
  useLabelsModal,
} from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';

import { ExternalSecretsModel } from '../../models';

type UseResourceActions = (
  model: ExternalSecretsModel,
  resource: K8sResourceCommon,
  options?: { supportsForceRefresh?: boolean },
) => [actions: Action[]];

export const useResourceActions: UseResourceActions = (model, resource, options) => {
  const { t } = useTranslation('plugin__external-secrets-console-plugin');
  const [k8sModel] = useK8sModel({ group: model.group, version: model.version, kind: model.kind });
  const launchLabelsModal = useLabelsModal(resource);
  const launchAnnotationsModal = useAnnotationsModal(resource);
  const launchDeleteModal = useDeleteModal(resource);

  const accessReview = (verb: 'update' | 'patch' | 'delete') => ({
    group: model.group,
    resource: model.plural,
    name: resource?.metadata?.name,
    namespace: resource?.metadata?.namespace,
    verb,
  });

  const actions: Action[] = [];

  if (options?.supportsForceRefresh && k8sModel) {
    actions.push({
      id: 'force-refresh',
      label: t('Force refresh'),
      cta: () =>
        k8sPatch({
          model: k8sModel,
          resource,
          data: [
            {
              op: 'add',
              path: '/metadata/annotations/force-sync',
              value: new Date().toISOString(),
            },
          ],
        }),
      accessReview: accessReview('patch'),
    });
  }

  actions.push(
    {
      id: 'edit-labels',
      label: t('Edit labels'),
      cta: launchLabelsModal,
      accessReview: accessReview('update'),
    },
    {
      id: 'edit-annotations',
      label: t('Edit annotations'),
      cta: launchAnnotationsModal,
      accessReview: accessReview('update'),
    },
    {
      id: 'delete',
      label: t('Delete {{kind}}', { kind: model.kind }),
      cta: launchDeleteModal,
      accessReview: accessReview('delete'),
    },
  );

  return [actions];
};
