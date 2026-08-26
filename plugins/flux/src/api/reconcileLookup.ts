import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';

import { toBase64Url } from '../utils/base64';

// Must match pluginMetadata.name in plugin-manifest.ts - console proxies
// backend routes for a loaded dynamic plugin at /api/plugins/<name>/..., then
// strips that whole prefix before forwarding to the backend (see
// api/reconcile.go's init() doc comment), so this path only has to make
// sense from the frontend's point of view.
const RECONCILE_PATH = '/api/plugins/flux-console-plugin/api/v1/reconcile';

export type ReconcileTarget = {
  group: string;
  version: string;
  kind: string;
  namespace: string;
  name: string;
  // Also reconcile the object's own source first (resolved server-side from
  // its spec) - mirrors `flux reconcile ... --with-source`. Only meaningful
  // for Kustomization, HelmRelease and HelmChart.
  withSource?: boolean;
  // HelmRelease-only, mirroring `flux reconcile helmrelease --force`/`--reset`.
  force?: boolean;
  reset?: boolean;
};

export type ReconcileResult = {
  requestedAt: string;
  sourceRequestedAt?: string;
  sourceKind?: string;
  sourceName?: string;
};

// Triggers an immediate reconciliation the same way `flux reconcile` does:
// the backend patches the object's (and, for withSource, its source's)
// `reconcile.fluxcd.io/requestedAt` annotation - see api/reconcile.go. This
// only requests the reconciliation; unlike the CLI, it does not wait for it
// to finish (a plugin backend route answers one GET with one response), so
// the result of the reconciliation itself shows up shortly afterwards via
// the list page's own live watch (Ready condition, revision, etc.).
export const reconcileResource = (target: ReconcileTarget): Promise<ReconcileResult> => {
  const payload = toBase64Url(target);
  return consoleFetchJSON(`${RECONCILE_PATH}/${payload}`);
};
