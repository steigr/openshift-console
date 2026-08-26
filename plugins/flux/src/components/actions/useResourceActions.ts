import {
  Action,
  K8sResourceCommon,
  k8sPatch,
  useAnnotationsModal,
  useDeleteModal,
  useLabelsModal,
} from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';

import { FluxModel, toK8sModel } from '../../models';
import { reconcileResource } from '../../api/reconcileLookup';

// Every one of the 11 kinds this plugin can reconcile (model.reconcile is
// set) also has a spec.suspend field, verified against a live cluster's CRD
// schemas - unlike reconcile, this goes through Console's own k8s API proxy
// as the logged-in user (a plain JSON Patch, no plugin backend involved),
// the same way edit-labels/edit-annotations/delete already do.
type Suspendable = K8sResourceCommon & { spec?: { suspend?: boolean } };

type UseResourceActions = (model: FluxModel, resource: Suspendable) => [actions: Action[]];

const runSuspendToggle = (t: (key: string) => string, promise: Promise<unknown>) => {
  promise.catch((err) => {
    // eslint-disable-next-line no-alert
    window.alert(`${t('Updating suspend state failed')}: ${err instanceof Error ? err.message : String(err)}`);
  });
};

// Fire-and-forget: the backend answers one GET with one response (see
// api/reconcile.go), it doesn't wait for the reconciliation to finish, and
// this plugin has no toast/notification mechanism wired up. So the only
// user-visible feedback on failure is this alert; on success there's none -
// the object's list row itself will reflect the new Ready condition/revision
// shortly, once its own live watch picks up the controller's update.
const runReconcile = (t: (key: string) => string, promise: Promise<unknown>) => {
  promise.catch((err) => {
    // eslint-disable-next-line no-alert
    window.alert(`${t('Reconcile failed')}: ${err instanceof Error ? err.message : String(err)}`);
  });
};

export const useResourceActions: UseResourceActions = (model, resource) => {
  const { t } = useTranslation('plugin__flux');
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
  ];

  // Gated on the same "patch" accessReview a real reconcile would need -
  // the backend actually performs the patch with its own ServiceAccount
  // (see charts/console-flux-plugin/templates/clusterrole.yaml), not the
  // logged-in user's token, so this check is a UI courtesy (hide the button
  // from someone who couldn't do this themselves) rather than the thing
  // actually enforcing who may trigger a reconciliation.
  if (model.reconcile) {
    const target = {
      group: model.group,
      version: model.version,
      kind: model.kind,
      namespace: resource?.metadata?.namespace || '',
      name: resource?.metadata?.name || '',
    };

    actions.push({
      id: 'reconcile',
      label: t('Reconcile now'),
      cta: () => runReconcile(t, reconcileResource(target)),
      accessReview: accessReview('patch'),
    });

    if (model.reconcile.withSource) {
      actions.push({
        id: 'reconcile-with-source',
        label: t('Reconcile with source'),
        cta: () => runReconcile(t, reconcileResource({ ...target, withSource: true })),
        accessReview: accessReview('patch'),
      });
    }

    if (model.reconcile.forceReset) {
      actions.push(
        {
          id: 'reconcile-force',
          label: t('Force reconcile'),
          cta: () => runReconcile(t, reconcileResource({ ...target, force: true })),
          accessReview: accessReview('patch'),
        },
        {
          id: 'reconcile-reset',
          label: t('Reset failures'),
          cta: () => runReconcile(t, reconcileResource({ ...target, reset: true })),
          accessReview: accessReview('patch'),
        },
      );
    }

    // "add" (not "replace") works whether spec.suspend is already present
    // on the object or not - a bare "replace" would 422 on an object that's
    // never been suspended before, since RFC 6902 requires the path to
    // already exist for "replace".
    const patchSuspend = (suspend: boolean) =>
      k8sPatch({
        model: toK8sModel(model),
        resource,
        data: [{ op: 'add', path: '/spec/suspend', value: suspend }],
      });

    if (!resource?.spec?.suspend) {
      actions.push({
        id: 'suspend',
        label: t('Suspend'),
        cta: () => runSuspendToggle(t, patchSuspend(true)),
        accessReview: accessReview('patch'),
      });
    } else {
      actions.push({
        id: 'resume',
        label: t('Resume'),
        cta: () => runSuspendToggle(t, patchSuspend(false)),
        accessReview: accessReview('patch'),
      });
    }
  }

  actions.push({
    id: 'delete',
    label: t('Delete {{kind}}', { kind: model.kind }),
    cta: launchDeleteModal,
    accessReview: accessReview('delete'),
  });

  return [actions];
};
