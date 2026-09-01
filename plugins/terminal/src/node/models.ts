import type { K8sModel } from '@openshift-console/dynamic-plugin-sdk';

export const PodModel: K8sModel = {
  abbr: 'PO',
  kind: 'Pod',
  label: 'Pod',
  labelPlural: 'Pods',
  plural: 'pods',
  apiVersion: 'v1',
  namespaced: true,
};

export const NamespaceModel: K8sModel = {
  abbr: 'NS',
  kind: 'Namespace',
  label: 'Namespace',
  labelPlural: 'Namespaces',
  plural: 'namespaces',
  apiVersion: 'v1',
  namespaced: false,
};

export const ConfigMapModel: K8sModel = {
  abbr: 'CM',
  kind: 'ConfigMap',
  label: 'ConfigMap',
  labelPlural: 'ConfigMaps',
  plural: 'configmaps',
  apiVersion: 'v1',
  namespaced: true,
};

export const ImageStreamTagModel: K8sModel = {
  abbr: 'IST',
  kind: 'ImageStreamTag',
  label: 'ImageStreamTag',
  labelPlural: 'ImageStreamTags',
  plural: 'imagestreamtags',
  apiVersion: 'v1',
  apiGroup: 'image.openshift.io',
  namespaced: true,
};

// Built into Kubernetes since 1.28 - see currentUser.ts for why this is
// used (learning the logged-in console user's own k8s-API-server identity).
export const SelfSubjectReviewModel: K8sModel = {
  abbr: 'SSR',
  kind: 'SelfSubjectReview',
  label: 'SelfSubjectReview',
  labelPlural: 'SelfSubjectReviews',
  plural: 'selfsubjectreviews',
  apiVersion: 'v1',
  apiGroup: 'authentication.k8s.io',
  namespaced: false,
};
