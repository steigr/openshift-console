import {
  Action,
  K8sResourceCommon,
  useAnnotationsModal,
  useDeleteModal,
  useLabelsModal,
} from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';

import { CertManagerModel } from '../../models';

type UseResourceActions = (
  model: CertManagerModel,
  resource: K8sResourceCommon,
) => [actions: Action[]];

export const useResourceActions: UseResourceActions = (model, resource) => {
  const { t } = useTranslation('plugin__cert-manager');
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

  const actions: Action[] = [
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
  ];

  return [actions];
};
