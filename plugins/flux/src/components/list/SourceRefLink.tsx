import * as React from 'react';
import { ResourceLink } from '@openshift-console/dynamic-plugin-sdk';

import { CrossNamespaceObjectReference } from '../../types';

// Every source a Kustomization/HelmChart/HelmRelease can point at
// (GitRepository/OCIRepository/HelmRepository/Bucket) lives under this one
// group/version, so a kind alone is enough to build the link's GVK.
const SOURCE_TOOLKIT_GROUP = 'source.toolkit.fluxcd.io';
const SOURCE_TOOLKIT_VERSION = 'v1';

// Renders a sourceRef (or chartRef) as a real link to the referenced
// object, the same way the Namespace column links to a Namespace, instead
// of the plain "Kind/name" text sourceRefLabel produces. namespace is the
// referencing object's own namespace, used when sourceRef.namespace is
// unset (defaulting to the same namespace, same as every Flux controller's
// own resolution).
const SourceRefLink: React.FC<{ sourceRef?: CrossNamespaceObjectReference; namespace?: string }> = ({
  sourceRef,
  namespace,
}) => {
  if (!sourceRef?.kind || !sourceRef?.name) {
    return <>-</>;
  }
  return (
    <ResourceLink
      groupVersionKind={{ group: SOURCE_TOOLKIT_GROUP, version: SOURCE_TOOLKIT_VERSION, kind: sourceRef.kind }}
      name={sourceRef.name}
      namespace={sourceRef.namespace || namespace}
    />
  );
};

export default SourceRefLink;
