import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';

import { consolePath } from '../utils/consolePath';

// Console's plugin proxy route for this plugin's backend: the name must match
// pluginMetadata.name in plugin-manifest.ts and the alias ("api") must match
// spec.proxy[].alias in the chart's consoleplugin.yaml. Console strips
// "/api/proxy/plugin/<name>/api/" and forwards the rest to the backend's
// Service with the method, query string and body intact - unlike the
// plugin-asset route (/api/plugins/<name>/...), which is GET-only. Prefixed
// with the base path console is served under, see consolePath.
const RECONCILE_PATH = '/api/proxy/plugin/flux-console-plugin/api/v1/reconcile';

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
// `reconcile.fluxcd.io/requestedAt` annotation - see api/reconcile.go. The
// patch is authorized as the logged-in user, whose credentials console
// forwards on this proxy route (authorization: UserToken), so it succeeds
// exactly when that user could have patched the object themselves.
//
// consoleFetchJSON.post sends the target as the request body and adds the
// CSRF token console requires on a non-GET request. This only requests the
// reconciliation; unlike the CLI, it does not wait for it to finish, so the
// result shows up shortly afterwards via the list page's own live watch
// (Ready condition, revision, etc.).
export const reconcileResource = (target: ReconcileTarget): Promise<ReconcileResult> =>
  consoleFetchJSON.post(consolePath(RECONCILE_PATH), target);
