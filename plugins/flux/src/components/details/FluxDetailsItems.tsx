import * as React from 'react';
import { DetailsItemComponentProps, K8sResourceCommon, ResourceLink } from '@openshift-console/dynamic-plugin-sdk';

import { LocalObjectReference } from '../../types';

type SourceWithSecretRef = K8sResourceCommon & { spec?: { secretRef?: LocalObjectReference } };

// console.resource/details-item component for every Flux source kind that
// carries an access-credentials secretRef (GitRepository, HelmRepository,
// OCIRepository, Bucket) - registered per-model in plugin-manifest.ts to add
// to the *default* Details tab's right column. secretRef is always a Secret
// in the object's own namespace (verified against a live cluster's CRD
// schema - no namespace field exists on it), never set for a source that
// needs no credentials (e.g. an anonymous public GitRepository), in which
// case this simply renders "-" rather than the whole item being omitted.
export const SecretRefItem: React.FC<DetailsItemComponentProps<SourceWithSecretRef>> = ({ obj }) => {
  const secretName = obj.spec?.secretRef?.name;
  if (!secretName) {
    return <>-</>;
  }
  return (
    <ResourceLink
      groupVersionKind={{ group: '', version: 'v1', kind: 'Secret' }}
      name={secretName}
      namespace={obj.metadata?.namespace}
    />
  );
};
